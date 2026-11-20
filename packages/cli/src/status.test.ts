import './test-network-block.cjs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computePassportFingerprint } from '@interfacedelta/core';
import { createBaseline } from './core';
import { parseArguments } from './arguments';
import { runCli } from './run';
import { statusSince } from './status';
import { passportFixture } from './test-fixture';

type Payload = {
  tools: { endpoint: string; tool: string }[];
  sinceTime: string;
  since?: unknown;
};
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function server(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => unknown | Promise<unknown>,
) {
  const instance = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        instance.close((error) => (error ? reject(error) : resolve()));
        instance.closeAllConnections();
      }),
  );
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  return `http://127.0.0.1:${address.port}`;
}
async function body(request: IncomingMessage) {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  return JSON.parse(raw);
}
function goal(input: Payload, changes: Record<string, unknown> = {}) {
  return {
    summary: {
      checked: input.tools.length,
      changedSinceStart: 0,
      breakingSinceStart: 0,
      notObserved: input.tools.length,
      stale: 0,
      movesMoneyOrDeletes: 0,
      asksForPayment: 0,
      declaredPaid: 0,
      ...changes,
    },
    tools: input.tools.map(() => ({
      recordCheck: '1',
      status: 'not_observed',
      changedSinceTime: false,
      signature: { jws: 'signed-tool', verify: '/api/v1/record/check/verify' },
    })),
    summarySignature: {
      jws: 'signed-goal',
      verify: '/api/v1/record/check/verify',
    },
  };
}
async function workspace(
  count: number,
  since = '2026-11-01T00:00:00.000Z',
  endpoint = 'https://tools.example/mcp',
) {
  const dir = await mkdtemp(join(tmpdir(), 'interfacedelta-status-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const passport = passportFixture();
  passport.endpoints.push({
    id: 'endpoint:tools',
    protocol: 'mcp',
    role: 'mcp.streamable-http',
    url: endpoint,
    originRelationship: 'cross_origin',
    relationship: 'explicitly_inspected',
    declarationSources: [],
    observationStatus: 'observed',
    artifactRefs: [],
  });
  for (let index = 0; index < count; index++)
    passport.capabilities.push({
      id: `capability:tool${index}`,
      kind: 'mcp.tool',
      protocol: 'mcp',
      protocolKey: `tool${index}`,
      name: `tool${index}`,
      sourceEndpointId: 'endpoint:tools',
      sourceRef: 'endpoint:tools',
      metadata: {},
      inventory: { complete: true },
      fingerprint: {
        algorithm: 'sha256',
        canonicalization: 'RFC8785',
        projectionVersion: 'capability-semantic-v4',
        value: 'a'.repeat(64),
      },
      provenance: [],
    });
  passport.fingerprints.passport.value = computePassportFingerprint(passport);
  const baseline = await createBaseline(
    'https://example.com',
    undefined,
    async () => passport,
    () => new Date(since),
  );
  await writeFile(join(dir, 'baseline.json'), JSON.stringify(baseline));
  const path = join(dir, 'dependencies.json');
  await writeFile(
    path,
    JSON.stringify({
      formatVersion: 'interfacedelta-dependencies-v1',
      dependencies: [
        {
          name: 'tools',
          url: 'https://example.com',
          baseline: 'baseline.json',
        },
      ],
    }),
  );
  return { path, dir, baseline };
}
async function run(
  path: string,
  api: string,
  options: string[] = [],
  key?: string,
) {
  let out = '',
    err = '';
  const code = await runCli(
    ['status', '--dependencies', path, '--api-url', api, ...options],
    {
      stdout: (value) => {
        out += value;
      },
      stderr: (value) => {
        err += value;
      },
      status: { env: key ? { INTERFACEDELTA_AGENT_KEY: key } : {} },
    },
  );
  return { code, out, err };
}
async function rest(changes: Record<string, unknown> = {}) {
  const seen: Payload[] = [],
    auth: (string | undefined)[] = [];
  const api = await server(async (req, res) => {
    expect(req.url).toBe('/api/v1/record/check/goal');
    auth.push(req.headers.authorization);
    const input = (await body(req)) as Payload;
    seen.push(input);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(goal(input, changes)));
  });
  return { api, seen, auth };
}
async function mcp(
  options: {
    sse?: boolean;
    quota?: boolean;
    hostile?: boolean;
    failure?: { code: string; message: string };
  } = {},
) {
  const calls: Record<string, unknown>[] = [];
  let text = '';
  const api = await server(async (req, res) => {
    expect(req.url).toBe('/mcp/public');
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.accept).toBe('application/json, text/event-stream');
    const rpc = await body(req);
    calls.push(rpc);
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown;
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'fake', version: '1' },
      };
    else {
      expect(rpc.params.name).toBe('check_tools');
      expect(req.headers['mcp-name']).toBe('check_tools');
      const signed = goal(rpc.params.arguments);
      if (options.hostile)
        signed.tools = signed.tools.map(() =>
          observed('\u001b[31mdelete\n\u202efake'),
        ) as typeof signed.tools;
      const value = options.quota
        ? {
            result: { message: 'limit' },
            quota: {
              keyless: true,
              remainingToday: 0,
              resetAt: '2026-11-20T00:00:00Z',
            },
          }
        : {
            result: signed,
            quota: {
              keyless: true,
              remainingToday: 295,
              resetAt: '2026-11-20T00:00:00Z',
            },
          };
      text = JSON.stringify(value, null, 2);
      result = {
        content: [{ type: 'text', text }],
        structuredContent: { ok: true, ...value },
      };
      if (options.failure) {
        // The server's own failure() shape: top-level { ok:false, error }.
        const failure = { ok: false, error: options.failure };
        text = JSON.stringify(failure, null, 2);
        result = {
          content: [{ type: 'text', text }],
          structuredContent: failure,
          isError: true,
        };
      }
    }
    const raw = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
    if (options.sse) {
      res.setHeader('content-type', 'text/event-stream');
      res.end(`event: message\ndata: ${raw}\n\n`);
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(raw);
    }
  });
  return { api, calls, text: () => text };
}
function observed(name = 'tool0') {
  return {
    recordCheck: '1',
    status: 'observed',
    changedSinceTime: true,
    signature: { jws: 'signed', verify: '/api/v1/record/check/verify' },
    service: { key: 'sha256:key', endpoint: 'https://tools.example/mcp' },
    tool: { name },
    observed: { stale: true },
    change: { last: { class: 'breaking', at: '2026-11-18T00:00:00Z' } },
    payment: { requiresPayment: true, declared: { state: 'declared_paid' } },
    effects: { classes: [{ class: 'deletes', p: 0.7 }] },
  };
}

describe('status reads the record only', () => {
  it('blocks real HTTPS before tests run', async () => {
    expect(() => httpsRequest('https://interfacedelta.com')).toThrow('blocked');
    await expect(fetch('https://interfacedelta.com')).rejects.toThrow(
      'blocked',
    );
  });
  it.each([1, 5])(
    'reads %i tools keylessly in one atomic MCP goal',
    async (size) => {
      const file = await workspace(size),
        fake = await mcp();
      const result = await run(file.path, fake.api);
      expect(result.code).toBe(0);
      expect(fake.calls.map((call) => call.method)).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/call',
      ]);
      const payload = (fake.calls[2]!.params as { arguments: Payload })
        .arguments;
      expect(payload.tools).toHaveLength(size);
      expect(payload.sinceTime).toBe(file.baseline.generatedAt);
      expect(payload).not.toHaveProperty('since');
      expect(result.out).toContain('not observed by InterfaceDelta');
      expect(result.out).toContain(
        'No recorded change is not proof of no change',
      );
    },
  );
  it.each([
    ['INVALID_ARGUMENTS', 2],
    ['SERVICE_UNAVAILABLE', 3],
  ] as const)(
    'shows the server message for a keyless %s failure (exit %i)',
    async (code, exit) => {
      const file = await workspace(1),
        fake = await mcp({
          failure: { code, message: 'tools[0].endpoint must be https' },
        });
      const result = await run(file.path, fake.api);
      expect(result.code).toBe(exit);
      expect(result.err).toContain('tools[0].endpoint must be https');
      expect(result.err).not.toContain('No goal returned');
    },
  );
  it('refuses more than five tools before any request, with the free-key hint', async () => {
    const file = await workspace(6),
      fake = await mcp();
    const result = await run(file.path, fake.api);
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      'POST https://interfacedelta.com/api/v1/agent-keys',
    );
    expect(result.err).toContain('INTERFACEDELTA_AGENT_KEY');
    expect(fake.calls).toHaveLength(0);
  });
  it.each([50, 51])(
    'batches %i keyed tools in groups of at most 50',
    async (size) => {
      const file = await workspace(size),
        fake = await rest();
      const outcome = await run(file.path, fake.api, [], 'fixture-agent-key');
      expect(outcome.code).toBe(0);
      expect(outcome.out).toContain(`Goal: ${size} checked`);
      expect(outcome.out.match(/https:\/\/tools.example\/mcp/g)).toHaveLength(
        1,
      );
      expect(fake.seen.map((input) => input.tools.length)).toEqual(
        size === 50 ? [50] : [50, 1],
      );
      expect(
        fake.auth.every((auth) => auth === 'Bearer fixture-agent-key'),
      ).toBe(true);
      expect(fake.seen.every((input) => !('since' in input))).toBe(true);
    },
  );
  it('uses --since, normalizing offsets and preserving fractional precision', async () => {
    const file = await workspace(1),
      fake = await rest();
    expect(
      (
        await run(
          file.path,
          fake.api,
          ['--since', '2026-11-02T03:00:00.123456+03:00'],
          'fixture-agent-key',
        )
      ).code,
    ).toBe(0);
    expect(fake.seen[0]!.sinceTime).toBe('2026-11-02T00:00:00.123456Z');
  });
  it('passes REST JSON through byte-for-byte', async () => {
    const file = await workspace(1);
    let raw = '';
    const api = await server(async (req, res) => {
      raw = ` \n${JSON.stringify(goal(await body(req)), null, 3)}\n `;
      res.end(raw);
    });
    const result = await run(file.path, api, ['--json'], 'fixture-agent-key');
    expect(result.code).toBe(0);
    expect(result.out).toBe(raw);
  });
  it.each([false, true])(
    'passes keyless tool JSON through (SSE=%s)',
    async (sse) => {
      const file = await workspace(1),
        fake = await mcp({ sse });
      const result = await run(file.path, fake.api, ['--json']);
      expect(result.code).toBe(0);
      expect(result.out).toBe(fake.text());
      expect(JSON.parse(result.out)).toHaveProperty('result.summarySignature');
    },
  );
  it('reports MCP pool exhaustion and its reset time even with ok:true', async () => {
    const file = await workspace(1),
      fake = await mcp({ quota: true });
    const result = await run(file.path, fake.api);
    expect(result.code).toBe(3);
    expect(result.err).toContain('2026-11-20T00:00:00Z');
    expect(result.err).not.toContain(' at ');
  });
  it.each(['header', 'body'])(
    'reports REST 429 reset time from the %s',
    async (mode) => {
      const file = await workspace(1);
      const api = await server((_req, res) => {
        res.writeHead(
          429,
          mode === 'header'
            ? { 'x-record-quota-reset': '2026-12-01T00:00:00Z' }
            : {},
        );
        res.end(JSON.stringify({ error: { resetAt: '2026-12-01T00:00:00Z' } }));
      });
      const result = await run(file.path, api, [], 'fixture-agent-key');
      expect(result.code).toBe(3);
      expect(result.err).toContain('2026-12-01T00:00:00Z');
    },
  );
  it.each([500, 503])('returns exit 3 for HTTP %i', async (status) => {
    const file = await workspace(1),
      api = await server((_req, res) => {
        res.writeHead(status);
        res.end('unavailable');
      });
    expect((await run(file.path, api, [], 'fixture-agent-key')).code).toBe(3);
  });
  it('returns exit 3 on network failure', async () => {
    const file = await workspace(1),
      api = await server((req) => req.socket.destroy());
    expect((await run(file.path, api, [], 'fixture-agent-key')).code).toBe(3);
  });
  it.each([
    ['changed', 1, 0, 1],
    ['breaking', 1, 0, 0],
    ['breaking', 0, 1, 1],
    ['changed', 0, 0, 0],
  ] as const)(
    'uses server counts for --fail-on %s (%i changed, %i breaking)',
    async (threshold, changed, breaking, code) => {
      const file = await workspace(1),
        fake = await rest({
          changedSinceStart: changed,
          breakingSinceStart: breaking,
        });
      const result = await run(
        file.path,
        fake.api,
        ['--fail-on', threshold],
        'fixture-agent-key',
      );
      expect(result.code).toBe(code);
      expect(result.out).toContain(
        `${changed} changed; ${breaking} breaking since start`,
      );
    },
  );
  it('reports changes without failing by default', async () => {
    const file = await workspace(1),
      fake = await rest({ breakingSinceStart: 1 });
    expect((await run(file.path, fake.api, [], 'fixture-agent-key')).code).toBe(
      0,
    );
  });
  it('sanitizes hostile network strings and shows attributed payment/effect facts without ANSI', async () => {
    const file = await workspace(1),
      fake = await mcp({ hostile: true });
    const result = await run(file.path, fake.api);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('\u001b');
    expect(result.out).not.toContain('\u202e');
    expect(result.out).toContain('delete\\nfake');
    expect(result.out).toContain(
      'breaking since start (latest recorded change)',
    );
    expect(result.out).toContain(
      'stale; asks for payment (HTTP 402 observed); declared paid; moves money or deletes (stored AI reading)',
    );
  });
  it.each(['dependencies', 'baseline'])(
    'reports missing %s with an actionable hint',
    async (missing) => {
      const file = await workspace(1),
        fake = await mcp();
      await rm(
        missing === 'dependencies'
          ? file.path
          : join(file.dir, 'baseline.json'),
      );
      const result = await run(file.path, fake.api);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(/Create it|interfacedelta baseline/);
      expect(fake.calls).toHaveLength(0);
    },
  );
  it('never sends requests to a dependency endpoint', async () => {
    let dependencyRequests = 0;
    const dependency = await server((_req, res) => {
      dependencyRequests++;
      res.end('dependency');
    });
    const file = await workspace(
        1,
        undefined,
        dependency.replace('http:', 'https:') + '/mcp',
      ),
      fake = await rest();
    expect((await run(file.path, fake.api, [], 'fixture-agent-key')).code).toBe(
      0,
    );
    expect(fake.seen[0]!.tools[0]!.endpoint).toBe(
      dependency.replace('http:', 'https:') + '/mcp',
    );
    expect(dependencyRequests).toBe(0);
  });
  it('refuses credential redirects without following or leaking the key', async () => {
    let redirected = 0;
    const destination = await server((_req, res) => {
      redirected++;
      res.end();
    });
    const api = await server((_req, res) => {
      res.writeHead(307, { location: destination });
      res.end();
    });
    const file = await workspace(1);
    const result = await run(file.path, api, [], 'fixture-agent-key');
    expect(result.code).toBe(3);
    expect(redirected).toBe(0);
    expect(result.err).not.toContain('fixture-agent-key');
  });
  it('rejects malformed goal results instead of reporting success', async () => {
    const file = await workspace(1),
      api = await server((_req, res) => res.end('{"summary":{}}'));
    expect((await run(file.path, api, [], 'fixture-agent-key')).code).toBe(3);
  });
  it('groups keyed baselines by creation time; keyless needs one shared time', async () => {
    const file = await workspace(1),
      fake = await rest();
    const other = { ...file.baseline, generatedAt: '2026-11-02T00:00:00.000Z' };
    await writeFile(join(file.dir, 'other.json'), JSON.stringify(other));
    await writeFile(
      file.path,
      JSON.stringify({
        formatVersion: 'interfacedelta-dependencies-v1',
        dependencies: [
          {
            name: 'first',
            url: 'https://example.com',
            baseline: 'baseline.json',
          },
          {
            name: 'second',
            url: 'https://example.com',
            baseline: 'other.json',
          },
        ],
      }),
    );
    expect((await run(file.path, fake.api)).code).toBe(2);
    expect(fake.seen).toHaveLength(0);
    expect((await run(file.path, fake.api, [], 'fixture-agent-key')).code).toBe(
      0,
    );
    expect(fake.seen.map((input) => input.sinceTime)).toEqual([
      file.baseline.generatedAt,
      other.generatedAt,
    ]);
    const publicFake = await mcp();
    expect(
      (
        await run(file.path, publicFake.api, [
          '--since',
          '2026-11-03T00:00:00Z',
        ])
      ).code,
    ).toBe(0);
  });
  it('compares fractional change times without inventing a breaking flag', async () => {
    const file = await workspace(1);
    const api = await server(async (req, res) => {
      const input = (await body(req)) as Payload;
      const result = {
        ...goal(input),
        tools: [
          {
            ...observed(),
            change: {
              last: { class: 'breaking', at: '2026-11-18T00:00:00.000001Z' },
            },
          },
        ],
      };
      res.end(JSON.stringify(result));
    });
    const result = await run(
      file.path,
      api,
      ['--since', '2026-11-18T00:00:00.000002Z'],
      'fixture-agent-key',
    );
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(
      'breaking since start (latest recorded change)',
    );
  });
  it('returns usage exit 2 for a rejected agent key', async () => {
    const file = await workspace(1),
      api = await server((_req, res) => {
        res.writeHead(401);
        res.end(JSON.stringify({ error: { message: 'Invalid key' } }));
      });
    const result = await run(file.path, api, [], 'fixture-agent-key');
    expect(result.code).toBe(2);
    expect(result.err).toContain('Invalid key');
  });
  it('documents help and rejects unsupported status flags and invalid times', async () => {
    for (const flag of ['--token', '--baseline', '--force', '--on-error'])
      expect(() => parseArguments(['status', flag, 'value'])).toThrow();
    expect(() => parseArguments(['status', '--fail-on', 'metadata'])).toThrow();
    expect(() => statusSince('yesterday')).toThrow('RFC3339');
    let help = '';
    expect(
      await runCli(['status', '--help'], {
        stdout: (value) => {
          help += value;
        },
      }),
    ).toBe(0);
    expect(help).toContain('/api/v1/record/check/verify');
    expect(help).toContain('Exit codes: 0');
    expect(parseArguments(['status']).dependencies).toBe(
      '.interfacedelta/dependencies.json',
    );
  });
});
