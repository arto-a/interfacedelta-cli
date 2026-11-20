import { canonicalJson } from '@interfacedelta/core';
import { z } from 'zod';
import type { ParsedArguments } from './arguments';
import { resolveTarget, validateBaseline } from './core';
import { baselinePathFor, loadDependencies } from './dependencies';
import { ConfigurationError, InspectionError } from './errors';
import { readJsonFile } from './io';
import { sanitizeTerminal } from './sanitize';
import { registerSecret } from './secrets';
import { CLI_VERSION } from './types';

export type StatusEnvironment = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
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
        last: z.object({ at: z.string(), class: z.string() }).nullable(),
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
type Goal = z.infer<typeof goalSchema>;
type InputTool = { endpoint: string; tool: string; sinceTime: string };

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

function apiBase(value = 'https://interfacedelta.com'): URL {
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

async function inputs(args: ParsedArguments): Promise<InputTool[]> {
  const since = args.since === undefined ? undefined : statusSince(args.since);
  const file = await loadDependencies(args.dependencies);
  const tools: InputTool[] = [];
  for (const entry of file.dependencies) {
    const baseline = validateBaseline(
      await readJsonFile(baselinePathFor(file, entry), 'Baseline'),
    );
    const target = resolveTarget(entry.url, entry.mcpEndpoint ?? undefined);
    if (
      canonicalJson(target.targetScope) !== canonicalJson(baseline.targetScope)
    )
      throw new ConfigurationError(
        `Baseline for ${entry.name} belongs to a different target. Record it again with interfacedelta baseline.`,
      );
    if (target.inspectionUrl !== baseline.inspectionUrl)
      throw new ConfigurationError(
        `Baseline for ${entry.name} inspected a different URL. Record it again with interfacedelta baseline.`,
      );
    const caps = baseline.passport.capabilities.filter(
      (cap) => cap.kind === 'mcp.tool',
    );
    for (const cap of caps) {
      const endpoint = baseline.passport.endpoints.find(
        (item) => item.protocol === 'mcp' && item.id === cap.sourceEndpointId,
      )?.url;
      if (!endpoint)
        throw new ConfigurationError(
          `Baseline for ${entry.name} has no endpoint for ${cap.name}. Record it again with interfacedelta baseline.`,
        );
      const url = new URL(endpoint);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        cap.name.length < 1 ||
        cap.name.length > 128
      )
        throw new ConfigurationError(
          `Baseline for ${entry.name} has an unsupported Record Check endpoint or tool name.`,
        );
      // CLI baselines can contain older capability projections. A hash-shaped
      // string alone does not prove equivalence with today's Record Check hash.
      tools.push({
        endpoint,
        tool: cap.name,
        sinceTime: since ?? baseline.generatedAt,
      });
    }
  }
  if (!tools.length)
    throw new ConfigurationError(
      'No MCP tools found in the baselines. Record MCP dependencies with interfacedelta baseline first.',
    );
  return tools;
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
async function request(
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
function parse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InspectionError('The record returned invalid JSON.');
  }
}
function goal(value: unknown, size: number): Goal {
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

async function keyless(env: StatusEnvironment, base: URL, batch: InputTool[]) {
  const url = new URL('/mcp/public', base);
  const headers = {
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
const payload = (batch: InputTool[]) => ({
  tools: batch.map(({ endpoint, tool }) => ({ endpoint, tool })),
  sinceTime: batch[0]!.sinceTime,
});

/** Match Record Check's UTC comparison without truncating fractional seconds. */
function atOrAfter(at: string, since: string): boolean {
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

function formatGoal(
  result: Pick<Goal, 'summary' | 'tools'>,
  batch: InputTool[],
): string {
  const lines: string[] = [];
  const servers = new Map<
    string,
    { tool: Goal['tools'][number]; input: InputTool }[]
  >();
  result.tools.forEach((tool, index) => {
    const input = batch[index]!;
    const server = servers.get(input.endpoint) ?? [];
    server.push({ tool, input });
    servers.set(input.endpoint, server);
  });
  for (const [endpoint, entries] of servers) {
    lines.push(sanitizeTerminal(endpoint));
    for (const { tool, input } of entries) {
      const facts: string[] = [];
      if (tool.status !== 'observed')
        facts.push(
          'not observed by InterfaceDelta',
          ...(tool.status === 'removed'
            ? ['removed from record']
            : tool.status === 'requires_sign_in'
              ? ['requires sign-in']
              : []),
        );
      else {
        const last = tool.change!.last;
        if (last?.class === 'breaking' && atOrAfter(last.at, input.sinceTime))
          facts.push('breaking since start (latest recorded change)');
        if (tool.changedSinceTime || tool.change!.changedSince)
          facts.push('changed');
        if (tool.observed!.stale) facts.push('stale');
        if (tool.payment!.requiresPayment)
          facts.push('asks for payment (HTTP 402 observed)');
        if (tool.payment!.declared?.state === 'declared_paid')
          facts.push('declared paid');
        if (
          tool.effects!.classes.some(
            (effect) =>
              effect.p >= 0.5 &&
              ['moves_money', 'deletes'].includes(effect.class),
          )
        )
          facts.push('moves money or deletes (stored AI reading)');
        if (!facts.length) facts.push('no change recorded since start');
      }
      lines.push(
        `  ${sanitizeTerminal(tool.tool?.name ?? input.tool)}: ${facts.join('; ')}`,
      );
    }
  }
  const s = result.summary;
  lines.push(
    `Goal: ${s.checked} checked; ${s.changedSinceStart} changed; ${s.breakingSinceStart} breaking since start; ${s.notObserved} not observed; ${s.stale} stale; ${s.asksForPayment} asks for payment; ${s.declaredPaid ?? 'not supplied'} declared paid; ${s.movesMoneyOrDeletes} moves money or deletes.`,
  );
  return lines.join('\n');
}

export async function runStatus(
  args: ParsedArguments,
  env: StatusEnvironment,
): Promise<{ output: string; exitCode: number }> {
  const base = apiBase(args.apiUrl);
  const tools = await inputs(args);
  const key = env.env.INTERFACEDELTA_AGENT_KEY?.trim();
  if (key) registerSecret(key);
  if (!key && tools.length > 5)
    throw new ConfigurationError(
      `Keyless status covers at most 5 tools, all-or-nothing; this project has ${tools.length}. ${KEY_HINT}`,
    );
  if (!key && new Set(tools.map((tool) => tool.sinceTime)).size > 1)
    throw new ConfigurationError(
      `Keyless status needs one shared start time. Use --since <RFC3339>, or set INTERFACEDELTA_AGENT_KEY to use each baseline's creation time. ${KEY_HINT}`,
    );
  const groups = new Map<string, InputTool[]>();
  for (const tool of tools) {
    const group = groups.get(tool.sinceTime) ?? [];
    group.push(tool);
    groups.set(tool.sinceTime, group);
  }
  const outputs: string[] = [];
  const checkedTools: Goal['tools'] = [];
  const checkedInputs: InputTool[] = [];
  const summary: Goal['summary'] = {
    checked: 0,
    changedSinceStart: 0,
    breakingSinceStart: 0,
    notObserved: 0,
    stale: 0,
    asksForPayment: 0,
    declaredPaid: 0,
    movesMoneyOrDeletes: 0,
  };
  let matched = false;
  for (const group of groups.values())
    for (let offset = 0; offset < group.length; offset += 50) {
      const batch = group.slice(offset, offset + 50);
      const response = key
        ? await (async () => {
            const raw = await request(
              env,
              new URL('/api/v1/record/check/goal', base),
              payload(batch),
              { authorization: `Bearer ${key}` },
            );
            return { raw, result: goal(parse(raw), batch.length) };
          })()
        : await keyless(env, base, batch);
      matched ||=
        args.failOn === 'changed'
          ? response.result.summary.changedSinceStart > 0
          : args.failOn === 'breaking'
            ? response.result.summary.breakingSinceStart > 0
            : false;
      outputs.push(response.raw);
      checkedTools.push(...response.result.tools);
      checkedInputs.push(...batch);
      // Only sum the server's counts; never reconstruct counts from tool flags.
      for (const field of [
        'checked',
        'changedSinceStart',
        'breakingSinceStart',
        'notObserved',
        'stale',
        'asksForPayment',
        'movesMoneyOrDeletes',
      ] as const)
        summary[field] += response.result.summary[field];
      if (
        summary.declaredPaid !== undefined &&
        response.result.summary.declaredPaid !== undefined
      )
        summary.declaredPaid += response.result.summary.declaredPaid;
      else delete summary.declaredPaid;
    }
  return {
    output: args.json
      ? outputs.join('\n')
      : `${formatGoal({ summary, tools: checkedTools }, checkedInputs)}\nNo recorded change is not proof of no change. Tool lines show the latest breaking change; goal counts include earlier recorded breaking changes.\nDetails: https://interfacedelta.com/atlas\n`,
    exitCode: matched ? 1 : 0,
  };
}
