import { z } from 'zod';
import type { CitationNetwork } from './citation-network';
import { ConfigurationError, InspectionError } from './errors';
import { sanitizeTerminal } from './sanitize';
import { CLI_VERSION } from './types';

export type StatusEnvironment = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  citationNetwork?: CitationNetwork;
};
const KEY_HINT =
  'Get a free key with one request: POST https://interfacedelta.com/api/v1/agent-keys. Set INTERFACEDELTA_AGENT_KEY to the returned key.';
const count = z.number().int().min(0).max(50);
const summarySchema = z
  .object({
    checked: count,
    changedSinceStart: count,
    breakingSinceStart: count,
    notObserved: count,
    stale: count,
    movesMoneyOrDeletes: count,
    asksForPayment: count,
    declaredPaid: count.optional(),
  })
  .passthrough();
const toolSchema = z
  .object({
    status: z.enum(['observed', 'not_observed', 'removed', 'requires_sign_in']),
    changedSinceTime: z.boolean(),
    signature: z.object({ jws: z.string(), verify: z.string() }),
    service: z
      .object({ key: z.string(), endpoint: z.string() })
      .passthrough()
      .optional(),
    tool: z.object({ name: z.string() }).passthrough().optional(),
    observed: z.object({ stale: z.boolean() }).passthrough().optional(),
    change: z
      .object({
        changedSince: z.boolean().optional(),
        last: z
          .object({ at: z.string(), class: z.string() })
          .passthrough()
          .nullable(),
      })
      .passthrough()
      .optional(),
    effects: z
      .object({
        classes: z.array(z.object({ class: z.string(), p: z.number() })),
      })
      .passthrough()
      .optional(),
    payment: z
      .object({
        requiresPayment: z.boolean(),
        declared: z.object({ state: z.string() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((tool, ctx) => {
    if (
      tool.status === 'observed' &&
      (!tool.service ||
        !tool.tool ||
        !tool.observed ||
        !tool.change ||
        !tool.effects ||
        !tool.payment)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Incomplete observed check',
      });
  });
const goalSchema = z
  .object({
    summary: summarySchema,
    tools: z.array(toolSchema),
    summarySignature: z.object({ jws: z.string(), verify: z.string() }),
  })
  .passthrough();
export type Goal = z.infer<typeof goalSchema>;
/** A tool to check; sinceTime is omitted when no start time is known. */
export type CheckToolInput = {
  endpoint: string;
  tool: string;
  sinceTime?: string;
};

/** Accept RFC3339 offsets, normalize to the UTC form accepted by Record Check. */
export function statusSince(value: string): string {
  if (
    !z.string().datetime({ offset: true }).safeParse(value).success ||
    !Number.isFinite(Date.parse(value))
  )
    throw new ConfigurationError(
      '--since must be an RFC3339 timestamp, for example 2026-11-19T00:00:00Z.',
    );
  // Preserve fractional precision: the record compares beyond milliseconds.
  const fraction = value.match(/\.(\d+)/)?.[1];
  const utc = new Date(value).toISOString().slice(0, 19);
  return `${utc}${fraction ? `.${fraction}` : ''}Z`;
}

export function apiBase(value = 'https://interfacedelta.com'): URL {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error();
    return url;
  } catch {
    throw new ConfigurationError(
      '--api-url must be an HTTPS origin without credentials, query or fragment (localhost HTTP is allowed for tests).',
    );
  }
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
function unavailable(status: number, value: unknown, headers?: Headers): never {
  const body = object(value);
  const error = object(body.error);
  if (status === 429) {
    const retry = headers?.get('retry-after');
    const retryTime =
      retry && /^\d+$/.test(retry)
        ? new Date(Date.now() + Number(retry) * 1000).toISOString()
        : retry;
    const reset =
      headers?.get('x-record-quota-reset') ??
      error.resetAt ??
      object(body.quota).resetAt ??
      retryTime ??
      'not supplied';
    throw new InspectionError(
      `Record limit reached; reset time: ${sanitizeTerminal(reset)}. ${KEY_HINT}`,
    );
  }
  if (status >= 500)
    throw new InspectionError(
      'The InterfaceDelta record is temporarily unavailable. Try again later.',
    );
  throw new ConfigurationError(
    `Record request refused (HTTP ${status}). ${sanitizeTerminal(error.message ?? body.message ?? 'Check --api-url and INTERFACEDELTA_AGENT_KEY.')}`,
  );
}

/** Bound every response, including SSE, under the request's abort deadline. */
export async function request(
  env: StatusEnvironment,
  url: URL,
  body: unknown,
  headers: Record<string, string>,
  notification = false,
): Promise<string> {
  try {
    const response = await env.fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new InspectionError(
              'Record response exceeds the size limit.',
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = {};
      }
      unavailable(response.status, value, response.headers);
    }
    if (notification) return '';
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      for (const event of raw.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const message = object(JSON.parse(data));
        if (message.id === object(body).id) return data;
      }
      throw new InspectionError(
        'Record MCP response did not contain the requested result.',
      );
    }
    return raw;
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof InspectionError)
      throw error;
    throw new InspectionError(
      'The InterfaceDelta record is unavailable (network or invalid response).',
    );
  }
}
export function parse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InspectionError('The record returned invalid JSON.');
  }
}
export function goal(value: unknown, size: number): Goal {
  const result = goalSchema.safeParse(value);
  if (
    !result.success ||
    result.data.tools.length !== size ||
    result.data.summary.checked !== size
  )
    throw new InspectionError(
      'The record returned an incomplete goal response.',
    );
  return result.data;
}

/** The public record MCP handshake; returns the session headers. */
export async function recordMcpHandshake(
  env: StatusEnvironment,
  url: URL,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26',
  };
  const init = object(
    parse(
      await request(
        env,
        url,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'interfacedelta', version: CLI_VERSION },
          },
        },
        headers,
      ),
    ),
  );
  if (init.error || !object(init.result).protocolVersion)
    throw new InspectionError('Record MCP initialization failed.');
  headers['mcp-protocol-version'] = String(object(init.result).protocolVersion);
  await request(
    env,
    url,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    headers,
    true,
  );
  return headers;
}

export async function keyless(
  env: StatusEnvironment,
  base: URL,
  batch: readonly CheckToolInput[],
) {
  const url = new URL('/mcp/public', base);
  const headers = await recordMcpHandshake(env, url);
  const rpc = object(
    parse(
      await request(
        env,
        url,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'check_tools', arguments: payload(batch) },
        },
        { ...headers, 'mcp-method': 'tools/call', 'mcp-name': 'check_tools' },
      ),
    ),
  );
  if (rpc.error)
    throw new InspectionError(
      `Record MCP error: ${sanitizeTerminal(object(rpc.error).message)}`,
    );
  const result = object(rpc.result);
  const content = Array.isArray(result.content)
    ? (result.content as { type?: string; text?: string }[])
    : [];
  const text = content.find((item) => item.type === 'text')?.text;
  const raw = text ?? JSON.stringify(result.structuredContent);
  const value = object(parse(raw));
  const structured = object(result.structuredContent);
  const quota = object(structured.quota ?? value.quota);
  const signed = value.result ?? structured.result;
  if (!object(signed).summary) {
    if (quota.resetAt) unavailable(429, { quota });
    if (result.isError || structured.ok === false) {
      // Forwarded HTTP errors nest under `result`; the server's own
      // validation failures are the top-level `{ ok:false, error }`.
      const error = object(
        object(signed).error ?? value.error ?? structured.error,
      );
      const code = String(error.code ?? '');
      if (code.includes('QUOTA') || code.includes('BURST'))
        unavailable(429, signed ?? value);
      if (code === 'INVALID_ARGUMENTS')
        throw new ConfigurationError(
          `Record MCP refused the request: ${sanitizeTerminal(error.message ?? code)}`,
        );
      throw new InspectionError(
        `Record MCP unavailable: ${sanitizeTerminal(error.message ?? object(signed).message ?? value.message ?? 'No goal returned.')}`,
      );
    }
    throw new InspectionError(
      `Record MCP returned no goal. ${sanitizeTerminal(object(signed).message ?? value.message)} ${KEY_HINT}`,
    );
  }
  return { raw, result: goal(signed, batch.length) };
}
export const payload = (batch: readonly CheckToolInput[]) => ({
  tools: batch.map(({ endpoint, tool }) => ({ endpoint, tool })),
  // An undefined start time is left out entirely (JSON.stringify drops it),
  // never sent as null or empty.
  ...(batch[0]!.sinceTime ? { sinceTime: batch[0]!.sinceTime } : {}),
});

/** Match Record Check's UTC comparison without truncating fractional seconds. */
export function atOrAfter(at: string, since: string): boolean {
  if (!z.string().datetime({ offset: true }).safeParse(at).success)
    return false;
  const left = statusSince(at),
    right = statusSince(since);
  const seconds = left.slice(0, 19).localeCompare(right.slice(0, 19), 'en');
  if (seconds !== 0) return seconds > 0;
  const a = left.match(/\.(\d+)/)?.[1] ?? '';
  const b = right.match(/\.(\d+)/)?.[1] ?? '';
  const precision = Math.max(a.length, b.length);
  return a.padEnd(precision, '0') >= b.padEnd(precision, '0');
}
