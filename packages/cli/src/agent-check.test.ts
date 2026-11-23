import './test-network-block.cjs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { parseArguments } from './arguments';
import {
  agentCheckSarif,
  parseAgentConfig,
  parseAgentFailOn,
  readAgentConfigs,
  userConfigPaths,
} from './agent-check';
import { runCli } from './run';

const HEADER_SECRET = 'literal-header-secret-1234567890';
const ENV_SECRET = 'literal-env-secret-abcdefghij';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `interfacedelta-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(path: string, contents: string) {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined);
  await writeFile(path, contents);
  return path;
}

describe('agent config readers are pure and deterministic', () => {
  it('reads all five formats by content, never printing env or header values', () => {
    const remote = {
      type: 'http',
      url: 'https://tools.example/mcp',
      headers: { Authorization: `Bearer ${HEADER_SECRET}` },
    };
    const local = {
      type: 'stdio',
      command: '/usr/local/bin/npx --yes builder-mcp',
      args: ['--flag', 'value'],
      env: { BUILDER_TOKEN: ENV_SECRET, MODE: '${UNSET_REFERENCE}' },
    };
    const expectServers = (servers: ReturnType<typeof parseAgentConfig>) => {
      expect(servers).toEqual([
        {
          kind: 'remote',
          name: 'search',
          url: 'https://tools.example/mcp',
          config: 'fixture',
        },
        {
          kind: 'stdio',
          name: 'builder',
          command: 'npx',
          config: 'fixture',
        },
      ]);
    };
    expectServers(
      parseAgentConfig(
        'fixture',
        JSON.stringify({ mcpServers: { search: remote, builder: local } }),
      ),
    );
    expectServers(
      parseAgentConfig(
        'fixture',
        JSON.stringify({
          globalShortcut: '',
          mcpServers: { search: remote, builder: local },
        }),
      ),
    );
    expectServers(
      parseAgentConfig(
        'fixture',
        JSON.stringify({
          servers: {
            search: {
              type: 'http',
              url: 'https://tools.example/mcp',
              headers: remote.headers,
            },
            builder: { type: 'stdio', command: local.command },
          },
        }),
      ),
    );
    expectServers(
      parseAgentConfig(
        'fixture',
        JSON.stringify({
          mcp: {
            servers: {
              search: { url: 'https://tools.example/mcp' },
              builder: { command: local.command },
            },
          },
        }),
      ),
    );
    // Parsing projects allowlisted fields only and has no I/O or redaction side effects.
  });

  it('rejects malformed JSON and configs without a server map', () => {
    expect(() => parseAgentConfig('c.json', '{')).toThrow('not valid JSON');
    expect(() => parseAgentConfig('c.json', '[]')).toThrow(
      'not a recognized MCP client config',
    );
    expect(() => parseAgentConfig('c.json', '{}')).toThrow(
      'not a recognized MCP client config',
    );
  });

  it('dedupes a directory by endpoint and orders by first appearance', async () => {
    const dir = await temp('configs');
    await write(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          first: { url: 'https://a.example/mcp' },
          onlyLocal: { command: 'npx' },
        },
      }),
    );
    await write(
      join(dir, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          duplicate: { url: 'https://a.example/mcp' },
          second: { url: 'https://b.example/mcp' },
        },
      }),
    );
    const read = await readAgentConfigs({ path: dir });
    expect(read.configs).toEqual([
      join(dir, '.mcp.json'),
      join(dir, '.cursor', 'mcp.json'),
    ]);
    expect(read.servers.map((server) => server.name)).toEqual([
      'first',
      'onlyLocal',
      'second',
    ]);
  });

  it('never reads the home directory unless asked', async () => {
    const project = await temp('project');
    await write(
      join(project, '.mcp.json'),
      '{"mcpServers":{"a":{"url":"https://a.example/mcp"}}}',
    );
    const home = await temp('home');
    await write(
      join(home, '.cursor', 'mcp.json'),
      '{"mcpServers":{"personal":{"url":"https://home.example/mcp"}}}',
    );
    const without = await readAgentConfigs(
      { path: project },
      { home, platform: 'linux' },
    );
    expect(without.servers.map((server) => server.name)).toEqual(['a']);
    const empty = await temp('empty');
    const userOnly = await readAgentConfigs(
      { path: empty, includeUserConfigs: true },
      { home, platform: 'linux' },
    );
    expect(userOnly.servers.map((server) => server.name)).toEqual(['personal']);
    expect(userConfigPaths('linux', home)).toEqual([
      join(home, '.config', 'Claude', 'claude_desktop_config.json'),
      join(home, '.cursor', 'mcp.json'),
      join(home, '.config', 'Code', 'User', 'settings.json'),
    ]);
    expect(userConfigPaths('darwin', home)[0]).toBe(
      join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      ),
    );
    expect(userConfigPaths('win32', home)[0]).toBe(
      join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    );
  });

  it('fails fast on a directory, file or list with no servers', async () => {
    const dir = await temp('none');
    await expect(readAgentConfigs({ path: dir })).rejects.toThrow(
      'No MCP client config found',
    );
    await expect(
      readAgentConfigs({ path: join(dir, 'missing') }),
    ).rejects.toThrow('Path could not be read');
    const empty = await write(join(dir, 'empty.json'), '{"mcpServers":{}}');
    const read = await readAgentConfigs({ config: empty });
    expect(read.servers).toEqual([]);
  });

  it('validates fail-on lists', () => {
    expect(parseAgentFailOn('breaking,payment')).toEqual([
      'breaking',
      'payment',
    ]);
    expect(parseAgentFailOn(' breaking , payment ')).toEqual([
      'breaking',
      'payment',
    ]);
    expect(parseAgentFailOn(undefined)).toEqual([]);
    expect(() => parseAgentFailOn('metadata')).toThrow('--fail-on accepts');
    expect(() => parseAgentFailOn(',')).toThrow('--fail-on accepts');
  });
});

type Payload = {
  tools: { endpoint: string; tool: string }[];
  sinceTime?: string;
};

type AtlasSpec = {
  target: string;
  endpoints?: { id: string; url: string; protocol?: string }[];
  tools?: { name: string; endpointId: string }[];
  firstObservedAt?: string;
  notFound?: boolean;
  ambiguous?: string[];
  full?: unknown;
  error?: { code: string; message: string };
};

const QUIET_TOOL = {
  recordCheck: '1',
  status: 'observed',
  changedSinceTime: false,
  signature: { jws: 'signed-quiet', verify: '/api/v1/record/check/verify' },
  service: { key: 'sha256:quiet', endpoint: 'https://tools.example/mcp' },
  tool: { name: 'search_docs' },
  observed: { stale: false },
  change: { changedSince: false, last: null },
  payment: { requiresPayment: false },
  effects: { classes: [] },
};
const LOUD_TOOL = {
  recordCheck: '1',
  status: 'observed',
  changedSinceTime: true,
  signature: { jws: 'signed-loud', verify: '/api/v1/record/check/verify' },
  service: { key: 'sha256:loud', endpoint: 'https://tools.example/mcp' },
  tool: { name: 'fetch_page' },
  observed: { stale: true },
  change: {
    changedSince: true,
    last: { class: 'breaking', at: '2026-11-15T00:00:00Z' },
  },
  payment: {
    requiresPayment: true,
    declared: { state: 'declared_paid' },
  },
  effects: {
    classes: [
      { class: 'moves_money', p: 0.9 },
      { class: 'sends_messages', p: 0.8 },
    ],
  },
};

function atlasFull(spec: AtlasSpec) {
  return {
    entry: {
      targetKey: `sha256:${spec.target.slice(0, 6).padEnd(64, '0')}`,
      origin: spec.target,
      observations: [
        { observedAt: spec.firstObservedAt ?? '2026-11-10T00:00:00.000Z' },
      ],
      lastObservedAt: '2026-11-20T00:00:00.000Z',
    },
    labels: { state: 'no label yet', signedAt: null, pending: true },
    passport: {
      currentPassport: {
        endpoints: (spec.endpoints ?? []).map((endpoint) => ({
          id: endpoint.id,
          protocol: endpoint.protocol ?? 'mcp',
          url: endpoint.url,
        })),
        capabilities: (spec.tools ?? []).map((tool) => ({
          kind: 'mcp.tool',
          name: tool.name,
          sourceEndpointId: tool.endpointId,
        })),
      },
    },
  };
}

async function body(request: IncomingMessage) {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  return JSON.parse(raw);
}

/** A fake InterfaceDelta record: atlas lookups on /mcp/public, goals on MCP and REST. */
async function record(
  atlas: AtlasSpec[],
  toolFor: (name: string) => Record<string, unknown> = () => QUIET_TOOL,
  transformGoal: (value: ReturnType<typeof goalFor>) => unknown = (value) =>
    value,
  options: { restFailureAt?: number } = {},
) {
  const mcpCalls: Record<string, unknown>[] = [];
  const restSeen: Payload[] = [];
  const restAuth: (string | undefined)[] = [];
  const instance = createServer((request, response) => {
    void (async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/api/v1/record/check/goal') {
        restAuth.push(req.headers.authorization);
        const input = (await body(req)) as Payload;
        restSeen.push(input);
        if (restSeen.length === options.restFailureAt) {
          res.writeHead(503);
          res.end('{}');
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(
            transformGoal(goalFor(input, toolFor, input.sinceTime ?? '')),
          ),
        );
        return;
      }
      expect(req.url).toBe('/mcp/public');
      expect(req.headers.authorization).toBeUndefined();
      const rpc = (await body(req)) as {
        id: number;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      mcpCalls.push(rpc);
      if (rpc.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      let result: unknown;
      if (rpc.method === 'initialize') {
        result = {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'fake', version: '1' },
        };
      } else if (rpc.params?.name === 'check_tools') {
        expect(req.headers['mcp-name']).toBe('check_tools');
        const input = rpc.params.arguments as Payload;
        const value = {
          result: transformGoal(goalFor(input, toolFor, input.sinceTime ?? '')),
          quota: {
            keyless: true,
            remainingToday: 295,
            resetAt: '2026-11-21T00:00:00Z',
          },
        };
        result = {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: { ok: true, ...value },
        };
      } else {
        expect(rpc.params?.name).toBe('get_atlas_entry');
        expect(req.headers['mcp-name']).toBe('get_atlas_entry');
        const args = rpc.params!.arguments as { target: string; view: string };
        expect(args.view).toBe('full');
        const spec = atlas.find((item) => item.target === args.target);
        let value: unknown;
        if (spec?.error) {
          value = { ok: false, error: spec.error };
          result = {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
            isError: true,
          };
        } else if (spec?.ambiguous) {
          value = {
            ok: false,
            error: {
              code: 'AMBIGUOUS_TARGET',
              message: 'Several services match.',
              candidates: spec.ambiguous.map((key) => ({
                targetKey: key,
                origin: 'https://shared.example',
              })),
            },
          };
          result = {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
            isError: true,
          };
        } else if (!spec || spec.notFound) {
          value = {
            ok: false,
            error: {
              code: 'NOT_FOUND',
              message: 'No accessible service matches.',
            },
          };
          result = {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
            isError: true,
          };
        } else {
          const full = spec.full ?? atlasFull(spec);
          result = {
            content: [{ type: 'text', text: JSON.stringify(full) }],
            structuredContent: { ok: true, result: full },
          };
        }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    })(request, response);
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
  return {
    api: `http://127.0.0.1:${address.port}`,
    mcpCalls,
    restSeen,
    restAuth,
  };
}

function goalFor(
  input: Payload,
  toolFor: (name: string) => Record<string, unknown>,
  sinceTime: string,
) {
  const tools = input.tools.map(({ tool }) => toolFor(tool));
  const paymentOf = (tool: Record<string, unknown>) =>
    tool.payment as {
      requiresPayment?: boolean;
      declared?: { state?: string };
    };
  const changeOf = (tool: Record<string, unknown>) =>
    tool.change as {
      changedSince?: boolean;
      last?: { class: string; at: string } | null;
    };
  const observedOf = (tool: Record<string, unknown>) =>
    tool.observed as { stale?: boolean };
  const effectsOf = (tool: Record<string, unknown>) =>
    tool.effects as { classes?: { class: string; p: number }[] };
  const summary = {
    checked: tools.length,
    changedSinceStart: tools.filter(
      (tool) => tool.changedSinceTime || changeOf(tool)?.changedSince,
    ).length,
    breakingSinceStart: tools.filter(
      (tool) =>
        changeOf(tool)?.last?.class === 'breaking' &&
        String(changeOf(tool).last!.at) >= sinceTime,
    ).length,
    notObserved: tools.filter((tool) => tool.status !== 'observed').length,
    stale: tools.filter((tool) => observedOf(tool)?.stale).length,
    movesMoneyOrDeletes: tools.filter((tool) =>
      effectsOf(tool)?.classes?.some(
        (effect) =>
          ['moves_money', 'deletes'].includes(effect.class) && effect.p >= 0.5,
      ),
    ).length,
    asksForPayment: tools.filter((tool) => paymentOf(tool)?.requiresPayment)
      .length,
    declaredPaid: tools.filter(
      (tool) => paymentOf(tool)?.declared?.state === 'declared_paid',
    ).length,
  };
  return {
    summary,
    tools,
    summarySignature: {
      jws: 'signed-goal',
      verify: '/api/v1/record/check/verify',
    },
  };
}

async function run(
  argv: string[],
  env: Record<string, string | undefined> = {},
) {
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    stdout: (value) => {
      out += value;
    },
    stderr: (value) => {
      err += value;
    },
    status: { env },
  });
  return { code, out, err };
}

const TOOLS_ATLAS: AtlasSpec[] = [
  {
    target: 'https://tools.example',
    endpoints: [{ id: 'e1', url: 'https://tools.example/mcp' }],
    tools: [
      { name: 'search_docs', endpointId: 'e1' },
      { name: 'fetch_page', endpointId: 'e1' },
    ],
  },
];

async function projectConfig(contents: unknown, name = '.mcp.json') {
  const dir = await temp('agent-check');
  return {
    dir,
    path: await write(join(dir, name), JSON.stringify(contents)),
  };
}

describe('agent-check reports the record for configured tools', () => {
  it('blocks real HTTPS before tests run', async () => {
    expect(() => httpsRequest('https://interfacedelta.com')).toThrow('blocked');
    await expect(fetch('https://interfacedelta.com')).rejects.toThrow(
      'blocked',
    );
  });

  it('reports per tool from the signed goal, keylessly, in one goal', async () => {
    const file = await projectConfig({
      mcpServers: {
        search: {
          type: 'http',
          url: 'https://tools.example/mcp',
          headers: { Authorization: `Bearer ${HEADER_SECRET}` },
        },
        builder: {
          command: '/usr/local/bin/npx --yes builder-mcp',
          env: { BUILDER_TOKEN: ENV_SECRET, MODE: '${UNSET_REFERENCE}' },
        },
      },
    });
    const fake = await record(TOOLS_ATLAS, (name) =>
      name === 'fetch_page' ? LOUD_TOOL : QUIET_TOOL,
    );
    const result = await run([
      'agent-check',
      '--config',
      file.path,
      '--api-url',
      fake.api,
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Recorded tools / facts');
    expect(result.out).toContain('search_docs: no change recorded since start');
    expect(result.out).toContain(
      'fetch_page: breaking since start (latest recorded change); changed; stale; asks for payment (HTTP 402 observed); declared paid; moves money (stored AI reading); sends messages (stored AI reading)',
    );
    expect(result.out).toContain('not checkable locally (command: npx)');
    expect(result.out).toContain(
      'Goal: 2 checked; 1 changed; 1 breaking since start; 0 not observed; 1 stale; 1 asks for payment; 1 declared paid; 1 moves money or deletes.',
    );
    // The configured servers are never called: only the record saw requests.
    expect(result.out).not.toContain(HEADER_SECRET);
    expect(result.out).not.toContain(ENV_SECRET);
    expect(
      fake.mcpCalls.filter((call) => call.method === 'tools/call').length,
    ).toBe(2);
    const goal = fake.mcpCalls.find(
      (call) =>
        (call as { params?: { name?: string } }).params?.name === 'check_tools',
    ) as { params: { arguments: Payload } };
    expect(goal.params.arguments.sinceTime).toBe('2026-11-10T00:00:00.000Z');
    expect(goal.params.arguments.tools).toEqual([
      { endpoint: 'https://tools.example/mcp', tool: 'search_docs' },
      { endpoint: 'https://tools.example/mcp', tool: 'fetch_page' },
    ]);
  });

  it('embeds every signed answer verbatim in the documented JSON shape', async () => {
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    const fake = await record(TOOLS_ATLAS, (name) =>
      name === 'fetch_page' ? LOUD_TOOL : QUIET_TOOL,
    );
    const result = await run([
      'agent-check',
      '--config',
      file.path,
      '--api-url',
      fake.api,
      '--json',
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.formatVersion).toBe('interfacedelta-agent-check-v1');
    expect(report.transport).toBe('mcp-public');
    expect(report.sinceSource).toBe('first-observed');
    expect(report.keylessLimit).toBeNull();
    expect(report.summary).toEqual({
      checked: 2,
      changedSinceStart: 1,
      breakingSinceStart: 1,
      notObserved: 0,
      stale: 1,
      movesMoneyOrDeletes: 1,
      asksForPayment: 1,
      declaredPaid: 1,
    });
    expect(report.servers).toHaveLength(1);
    const server = report.servers[0];
    expect(server).toMatchObject({
      name: 'search',
      kind: 'remote',
      status: 'checked',
      target: 'https://tools.example/mcp',
      recordedEndpoint: 'https://tools.example/mcp',
      firstObservedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(server.tools[1]).toEqual({
      name: 'fetch_page',
      status: 'observed',
      changed: true,
      breakingSinceStart: true,
      stale: true,
      asksForPayment: true,
      declaredPaid: true,
      movesMoney: true,
      deletes: false,
      sendsMessages: true,
      check: LOUD_TOOL,
    });
    expect(report.goalResponses).toHaveLength(1);
    expect(report.goalResponses[0].transport).toBe('mcp-public');
    expect(report.goalResponses[0].goal.tools).toEqual([QUIET_TOOL, LOUD_TOOL]);
    expect(report.goalResponses[0].goal.summarySignature).toEqual({
      jws: 'signed-goal',
      verify: '/api/v1/record/check/verify',
    });
    expect(report.goalResponses[0].quota).toEqual({
      keyless: true,
      remainingToday: 295,
      resetAt: '2026-11-21T00:00:00Z',
    });
  });

  it('writes SARIF for the Action with facts as results', async () => {
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    const fake = await record(TOOLS_ATLAS, (name) =>
      name === 'fetch_page' ? LOUD_TOOL : QUIET_TOOL,
    );
    vi.spyOn(process, 'cwd').mockReturnValue(file.dir);
    const sarif = join(file.dir, 'out.sarif');
    const result = await run([
      'agent-check',
      '--config',
      file.path,
      '--api-url',
      fake.api,
      '--sarif',
      sarif,
    ]);
    expect(result.code).toBe(0);
    const log = JSON.parse(await readFile(sarif, 'utf8')) as {
      version: string;
      runs: {
        tool: { driver: { name: string } };
        results: {
          ruleId: string;
          level: string;
          locations: {
            physicalLocation: { artifactLocation: { uri: string } };
          }[];
          partialFingerprints: Record<string, string>;
        }[];
      }[];
    };
    expect(log.version).toBe('2.1.0');
    expect(log.runs[0].tool.driver.name).toBe('InterfaceDelta');
    const ids = log.runs[0].results.map(
      (result: { ruleId: string; level: string }) =>
        `${result.ruleId}:${result.level}`,
    );
    expect(ids).toEqual([
      'AGENT_CHECK_BREAKING_SINCE_START:error',
      'AGENT_CHECK_CHANGED:warning',
      'AGENT_CHECK_STALE:note',
      'AGENT_CHECK_ASKS_FOR_PAYMENT:warning',
      'AGENT_CHECK_DECLARED_PAID:note',
      'AGENT_CHECK_MOVES_MONEY:warning',
      'AGENT_CHECK_SENDS_MESSAGES:note',
    ]);
    expect(
      new Set(
        log.runs[0].results.map(
          (result) => result.locations[0].physicalLocation.artifactLocation.uri,
        ),
      ),
    ).toEqual(new Set(['.mcp.json']));
    expect(log.runs[0].results[0].partialFingerprints).toHaveProperty(
      'interfacedeltaAgentCheck/v1',
    );
  });

  it('reports a server the record has no entry for, and fails only on request', async () => {
    const file = await projectConfig({
      mcpServers: {
        known: { url: 'https://tools.example/mcp' },
        unknown: { url: 'https://unknown.example/mcp' },
        elsewhere: { url: 'https://tools.example/other' },
      },
    });
    const fake = await record([
      ...TOOLS_ATLAS,
      { target: 'https://unknown.example', notFound: true },
    ]);
    const quiet = await run(['agent-check', file.dir, '--api-url', fake.api]);
    expect(quiet.code).toBe(0);
    expect(quiet.out).toContain('https://unknown.example/mcp (unknown)');
    expect(quiet.out).toContain('not observed by InterfaceDelta');
    expect(quiet.out).toContain('https://tools.example/other (elsewhere)');
    // One lookup per origin; the unmatched endpoint of a known origin is
    // still not observed.
    expect(
      fake.mcpCalls.filter((call) => call.method === 'tools/call').length,
    ).toBe(3);
    const failing = await run([
      'agent-check',
      file.dir,
      '--api-url',
      fake.api,
      '--fail-on',
      'not_observed',
    ]);
    expect(failing.code).toBe(1);
  });

  it('checks the first five tools keylessly and says so', async () => {
    const many: AtlasSpec[] = [
      {
        target: 'https://tools.example',
        endpoints: [{ id: 'e1', url: 'https://tools.example/mcp' }],
        tools: Array.from({ length: 7 }, (_, index) => ({
          name: `tool${index}`,
          endpointId: 'e1',
        })),
      },
    ];
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    const fake = await record(many);
    const result = await run([
      'agent-check',
      '--config',
      file.path,
      '--api-url',
      fake.api,
      '--json',
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.keylessLimit).toEqual({
      limit: 5,
      checked: 5,
      unchecked: 2,
    });
    expect(
      report.servers[0].tools.map((tool: { name: string; status: string }) => [
        tool.name,
        tool.status,
      ]),
    ).toEqual([
      ['tool0', 'observed'],
      ['tool1', 'observed'],
      ['tool2', 'observed'],
      ['tool3', 'observed'],
      ['tool4', 'observed'],
      ['tool5', 'not_checked'],
      ['tool6', 'not_checked'],
    ]);
    const human = await run([
      'agent-check',
      '--config',
      file.path,
      '--api-url',
      fake.api,
    ]);
    expect(human.out).toContain(
      'Keyless check covers the first 5 of 7 tools; set INTERFACEDELTA_AGENT_KEY to check the rest.',
    );
    expect(human.out).toContain(
      'POST https://interfacedelta.com/api/v1/agent-keys',
    );
    expect(human.out).toContain(
      'tool5: not checked (keyless limit; set INTERFACEDELTA_AGENT_KEY)',
    );
  });

  it('uses an agent key for REST batches of 50 and --since normalization', async () => {
    const many: AtlasSpec[] = [
      {
        target: 'https://tools.example',
        endpoints: [{ id: 'e1', url: 'https://tools.example/mcp' }],
        tools: Array.from({ length: 60 }, (_, index) => ({
          name: `tool${index}`,
          endpointId: 'e1',
        })),
      },
    ];
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    const fake = await record(many);
    const result = await run(
      [
        'agent-check',
        '--config',
        file.path,
        '--api-url',
        fake.api,
        '--since',
        '2026-11-05T02:00:00+02:00',
      ],
      { INTERFACEDELTA_AGENT_KEY: 'fixture-agent-key' },
    );
    expect(result.code).toBe(0);
    expect(fake.restSeen.map((input) => input.tools.length)).toEqual([50, 10]);
    expect(
      fake.restAuth.every((auth) => auth === 'Bearer fixture-agent-key'),
    ).toBe(true);
    expect(
      fake.restSeen.every(
        (input) => input.sinceTime === '2026-11-05T00:00:00Z',
      ),
    ).toBe(true);
    expect(
      fake.mcpCalls.filter((call) => call.method === 'tools/call').length,
    ).toBe(1);
    expect(result.out).toContain('Goal: 60 checked');
    const report = JSON.parse(
      (
        await run(
          [
            'agent-check',
            '--config',
            file.path,
            '--api-url',
            fake.api,
            '--since',
            '2026-11-05T00:00:00Z',
            '--json',
          ],
          { INTERFACEDELTA_AGENT_KEY: 'fixture-agent-key' },
        )
      ).out,
    );
    expect(report.transport).toBe('rest');
    expect(report.sinceSource).toBe('--since');
    expect(report.goalResponses).toHaveLength(2);
    expect(
      report.goalResponses.every(
        (item: { transport: string }) => item.transport === 'rest',
      ),
    ).toBe(true);
  });

  it('fails on the requested conditions using the returned summary counts', async () => {
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    const fake = await record(TOOLS_ATLAS, (name) =>
      name === 'fetch_page' ? LOUD_TOOL : QUIET_TOOL,
    );
    expect(
      (
        await run([
          'agent-check',
          '--config',
          file.path,
          '--api-url',
          fake.api,
          '--fail-on',
          'breaking,payment',
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await run([
          'agent-check',
          '--config',
          file.path,
          '--api-url',
          fake.api,
          '--fail-on',
          'money',
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await run([
          'agent-check',
          '--config',
          file.path,
          '--api-url',
          fake.api,
          '--fail-on',
          'changed,stale',
        ])
      ).code,
    ).toBe(1);
    const quietFake = await record(TOOLS_ATLAS);
    expect(
      (
        await run([
          'agent-check',
          '--config',
          file.path,
          '--api-url',
          quietFake.api,
          '--fail-on',
          'breaking,payment,money,not_observed',
        ])
      ).code,
    ).toBe(0);
  });

  it('resolves an ambiguous host by trying the record candidates', async () => {
    const withKeys = 'sha256:' + 'c'.repeat(64);
    const withoutKeys = 'sha256:' + 'b'.repeat(64);
    const file = await projectConfig({
      mcpServers: { shared: { url: 'https://shared.example/mcp' } },
    });
    const fake = await record([
      { target: 'https://shared.example', ambiguous: [withoutKeys, withKeys] },
      {
        target: withoutKeys,
        endpoints: [{ id: 'x', url: 'https://other.example/mcp' }],
        tools: [{ name: 'unrelated', endpointId: 'x' }],
      },
      {
        target: withKeys,
        endpoints: [{ id: 'y', url: 'https://shared.example/mcp' }],
        tools: [{ name: 'shared_tool', endpointId: 'y' }],
      },
    ]);
    const result = await run([
      'agent-check',
      '--config',
      file.path,
      '--api-url',
      fake.api,
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('shared_tool: no change recorded since start');
    const targets = fake.mcpCalls
      .filter(
        (call) =>
          (call as { params?: { name?: string } }).params?.name ===
          'get_atlas_entry',
      )
      .map(
        (call) =>
          (call as { params: { arguments: { target: string } } }).params
            .arguments.target,
      );
    expect(targets).toEqual(['https://shared.example', withoutKeys, withKeys]);
  });

  it('leaves stdio-only configs local without any record request', async () => {
    const file = await projectConfig({
      mcpServers: { local: { command: 'node server.js' } },
    });
    const fake = await record(TOOLS_ATLAS);
    const result = await run([
      'agent-check',
      '--config',
      file.path,
      '--api-url',
      fake.api,
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('not checkable locally (command: node)');
    expect(result.out).toContain('Goal: 0 checked');
    expect(fake.mcpCalls).toHaveLength(0);
    expect(fake.restSeen).toHaveLength(0);
  });

  it('marks non-HTTPS endpoints not checkable before any request', async () => {
    const file = await projectConfig({
      mcpServers: {
        plain: { url: 'http://tools.example/mcp' },
        broken: { url: 'https://user:pass@tools.example/mcp' },
        frag: { url: 'https://tools.example/mcp?x=1' },
      },
    });
    const fake = await record(TOOLS_ATLAS);
    const result = await run([
      'agent-check',
      '--config',
      file.path,
      '--api-url',
      fake.api,
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      'not checkable: Record Check covers HTTPS endpoints only',
    );
    expect(result.out).toContain(
      'not checkable: URLs with credentials cannot be checked',
    );
    expect(result.out).toContain(
      'not checkable: URLs with a query or fragment cannot be checked',
    );
    expect(fake.mcpCalls).toHaveLength(0);
  });

  it('reports unavailable records with exit 3 and usage errors with exit 2', async () => {
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    const badJson = await write(join(file.dir, 'bad.json'), '{');
    expect(
      (
        await run([
          'agent-check',
          '--config',
          badJson,
          '--api-url',
          'https://x',
        ])
      ).code,
    ).toBe(2);
    const noServers = await write(
      join(file.dir, 'none.json'),
      '{"mcpServers":{}}',
    );
    const noServersRun = await run([
      'agent-check',
      '--config',
      noServers,
      '--api-url',
      'https://x',
    ]);
    expect(noServersRun.code).toBe(2);
    expect(noServersRun.err).toContain('No MCP servers found');
    const empty = await write(join(file.dir, 'unrecognized.json'), '{}');
    expect(
      (await run(['agent-check', '--config', empty, '--api-url', 'https://x']))
        .code,
    ).toBe(2);
    const bare = await temp('bare');
    expect(
      (await run(['agent-check', bare, '--api-url', 'https://x'])).code,
    ).toBe(2);
    expect(
      (
        await run([
          'agent-check',
          '--config',
          file.path,
          '--api-url',
          'https://interfacedelta.com',
        ])
      ).code,
    ).toBe(3);
    expect(
      (
        await run([
          'agent-check',
          '--config',
          file.path,
          '--api-url',
          'https://x',
          '--since',
          'yesterday',
        ])
      ).code,
    ).toBe(2);
  });

  it('documents help and rejects unsupported agent-check flags', async () => {
    for (const argv of [
      ['agent-check', '--token', 'value'],
      ['agent-check', 'a', 'b'],
      ['agent-check', 'dir', '--config', 'f'],
      ['agent-check', '--fail-on', 'metadata'],
      ['agent-check', '--dependencies', 'x'],
    ])
      expect(() => parseArguments(argv)).toThrow();
    const parsed = parseArguments(['agent-check']);
    expect(parsed.agentPath).toBe('.');
    expect(parsed.command).toBe('agent-check');
    expect(parseArguments(['agent-check', 'here', '--json']).agentPath).toBe(
      'here',
    );
    expect(
      parseArguments(['agent-check', '--fail-on', 'breaking , payment']).failOn,
    ).toBe('breaking,payment');
    expect(
      parseArguments(['agent-check', '--include-user-configs'])
        .includeUserConfigs,
    ).toBe(true);
    let help = '';
    expect(
      await runCli(['agent-check', '--help'], {
        stdout: (value) => {
          help += value;
        },
      }),
    ).toBe(0);
    expect(help).toContain('interfacedelta agent-check');
    expect(help).toContain('not_checkable_local');
    expect(help).toContain('Exit codes: 0 no condition matched');
  });
});

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/agent-check/', import.meta.url),
);

describe('agent-check completion regressions', () => {
  it('emits nothing when a second REST goal batch fails after the first succeeds', async () => {
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    const fake = await record(
      [
        {
          ...TOOLS_ATLAS[0]!,
          tools: Array.from({ length: 51 }, (_, i) => ({
            name: `tool${i}`,
            endpointId: 'e1',
          })),
        },
      ],
      undefined,
      undefined,
      { restFailureAt: 2 },
    );
    const sarif = join(file.dir, 'must-not-exist.sarif');
    const result = await run(
      [
        'agent-check',
        file.dir,
        '--api-url',
        fake.api,
        '--json',
        '--sarif',
        sarif,
      ],
      { INTERFACEDELTA_AGENT_KEY: 'fixture-second-batch-key' },
    );
    expect(fake.restSeen.map((input) => input.tools.length)).toEqual([50, 1]);
    expect(result.code).toBe(3);
    expect(result.out).toBe('');
    expect(result.err).toContain('temporarily unavailable');
    await expect(readFile(sarif)).rejects.toThrow();
  });

  it('bounds ambiguous lookups to five candidates and fails without partial output', async () => {
    const keys = 'abcdef'.split('').map((char) => `sha256:${char.repeat(64)}`);
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://shared.example/mcp' } },
    });
    const fake = await record([
      { target: 'https://shared.example', ambiguous: keys },
      ...keys.map((target, i) => ({
        target,
        endpoints: [
          { id: 'e', url: `https://shared.example/${i === 5 ? 'mcp' : i}` },
        ],
        tools: [{ name: 'search_docs', endpointId: 'e' }],
      })),
    ]);
    const result = await run([
      'agent-check',
      file.dir,
      '--api-url',
      fake.api,
      '--json',
    ]);
    expect(result.code).toBe(3);
    expect(result.out).toBe('');
    expect(result.err).toContain(
      'more candidate services than this lookup can resolve',
    );
    expect(
      fake.mcpCalls.flatMap((call) => {
        const params = call.params as
          { name?: string; arguments?: { target: string } } | undefined;
        return params?.name === 'get_atlas_entry'
          ? [params.arguments!.target]
          : [];
      }),
    ).toEqual(['https://shared.example', ...keys.slice(0, 5)]);
  });

  it('refuses ambiguous candidates that disagree on the configured endpoint tools', async () => {
    const keys = 'abc'.split('').map((char) => `sha256:${char.repeat(64)}`);
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://shared.example/mcp' } },
    });
    const fake = await record([
      { target: 'https://shared.example', ambiguous: keys },
      ...keys.map((target, i) => ({
        target,
        endpoints: [{ id: 'e', url: 'https://shared.example/mcp' }],
        tools: [
          { name: i === 2 ? 'different_tool' : 'search_docs', endpointId: 'e' },
        ],
      })),
    ]);
    const result = await run([
      'agent-check',
      file.dir,
      '--api-url',
      fake.api,
      '--json',
    ]);
    expect(result.code).toBe(3);
    expect(result.out).toBe('');
    expect(result.err).toContain('Several recorded services disagree');
    expect(
      fake.mcpCalls.filter(
        (call) => (call.params as { name?: string })?.name === 'check_tools',
      ),
    ).toHaveLength(0);
  });

  it('reads opted-in user configs through the CLI and keeps their SARIF facts location-less', async () => {
    const checkout = await temp('user-config-project');
    const home = await temp('private-home');
    const config = await write(
      join(home, '.cursor/mcp.json'),
      JSON.stringify({
        mcpServers: { personal: { url: 'https://tools.example/mcp' } },
      }),
    );
    vi.stubEnv('HOME', home);
    vi.spyOn(process, 'cwd').mockReturnValue(checkout);
    const fake = await record(TOOLS_ATLAS, () => LOUD_TOOL);
    const sarif = join(checkout, 'result.sarif');
    const result = await run([
      'agent-check',
      checkout,
      '--include-user-configs',
      '--api-url',
      fake.api,
      '--json',
      '--sarif',
      sarif,
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    // JSON identifies explicitly included source configs; SARIF avoids home paths.
    expect(report.configs).toEqual([config]);
    expect(report.servers[0]).toMatchObject({
      name: 'personal',
      config,
      status: 'checked',
    });
    const output = await readFile(sarif, 'utf8');
    const findings = JSON.parse(output).runs[0].results;
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings)
      expect(finding).not.toHaveProperty('locations');
    expect(output).not.toContain(home);
    expect(output).not.toContain(checkout);
    expect(output).not.toContain('.cursor');
  });

  it.each([
    null,
    {},
    'invalid',
    [{ observedAt: 123 }],
    [{}],
    [{ observedAt: '' }],
    [{ observedAt: 'invalid' }],
    [{ observedAt: '2026-11-20T00:00:00Z' }, {}],
  ])(
    'refuses malformed observation history without substituting lastObservedAt: %j',
    async (observations) => {
      const file = await projectConfig({
        mcpServers: { search: { url: 'https://tools.example/mcp' } },
      });
      const full = atlasFull(TOOLS_ATLAS[0]!);
      const fake = await record([
        {
          target: 'https://tools.example',
          full: {
            ...full,
            entry: { ...full.entry, observations },
          },
        },
      ]);
      const sarif = join(file.dir, 'must-not-exist.sarif');
      const result = await run([
        'agent-check',
        file.dir,
        '--api-url',
        fake.api,
        '--json',
        '--sarif',
        sarif,
        '--fail-on',
        'breaking',
      ]);
      expect(result.code).toBe(3);
      expect(result.out).toBe('');
      expect(result.err).toContain('incomplete atlas entry');
      expect(
        fake.mcpCalls.filter(
          (call) => (call.params as { name?: string })?.name === 'check_tools',
        ),
      ).toHaveLength(0);
      await expect(readFile(sarif)).rejects.toThrow();
    },
  );

  it.each(['newest-first', 'absent', 'empty'])(
    'uses only the available observation start for %s history',
    async (history) => {
      const file = await projectConfig({
        mcpServers: { search: { url: 'https://tools.example/mcp' } },
      });
      const full = atlasFull(TOOLS_ATLAS[0]!);
      const entry: Record<string, unknown> = { ...full.entry };
      if (history === 'absent') delete entry.observations;
      else
        entry.observations =
          history === 'empty'
            ? []
            : [
                { observedAt: full.entry.lastObservedAt },
                ...full.entry.observations,
              ];
      const fake = await record([
        { target: 'https://tools.example', full: { ...full, entry } },
      ]);
      const result = await run([
        'agent-check',
        file.dir,
        '--api-url',
        fake.api,
        '--json',
      ]);
      expect(result.code).toBe(0);
      const expected =
        history === 'empty'
          ? null
          : history === 'absent'
            ? full.entry.lastObservedAt
            : full.entry.observations[0]!.observedAt;
      expect(JSON.parse(result.out).sinceTime).toBe(expected);
      const goal = fake.mcpCalls.find(
        (call) => (call.params as { name?: string })?.name === 'check_tools',
      );
      expect((goal!.params as { arguments: Payload }).arguments.sinceTime).toBe(
        expected ?? undefined,
      );
    },
  );

  it('checks matched tools with common short config values and preserves signed output', async () => {
    const contents = JSON.parse(
      await readFile(join(fixtureRoot, 'common-values.json'), 'utf8'),
    );
    const file = await projectConfig(contents, '.mcp0.json');
    const endpoint = 'https://tools.example:8080/mcp';
    const signed = {
      ...QUIET_TOOL,
      service: { ...QUIET_TOOL.service, endpoint },
    };
    const fake = await record(
      [
        {
          target: 'https://tools.example:8080',
          endpoints: [{ id: 'e1', url: endpoint }],
          tools: [{ name: 'search_docs', endpointId: 'e1' }],
        },
      ],
      () => signed,
    );
    const sarif = join(file.dir, 'result.sarif');
    const args = ['agent-check', '--config', file.path, '--api-url', fake.api];
    const result = await run([...args, '--json', '--sarif', sarif]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const report = JSON.parse(result.out);
    expect(report.configs).toEqual([file.path]);
    expect(report.sinceTime).toBe('2026-11-10T00:00:00.000Z');
    expect(report.summary.checked).toBe(1);
    expect(report.servers[1].target).toBe(endpoint);
    expect(report.goalResponses[0].goal.tools).toEqual([signed]);
    expect(report.servers[0]).toEqual({
      name: 'local',
      config: file.path,
      kind: 'stdio',
      status: 'not_checkable_local',
      target: 'node',
    });
    expect(result.out).not.toMatch(/"(env|args|headers|CI|DEBUG|PORT|MODE)"/);
    expect(JSON.parse(await readFile(sarif, 'utf8')).version).toBe('2.1.0');
    const table = await run(args);
    expect(table.code).toBe(0);
    expect(table.out).toContain(endpoint);
    expect(table.out).toContain('Goal: 1 checked');
  });

  it('rejects every unclassifiable named entry rather than silently dropping coverage', async () => {
    const contents = JSON.parse(
      await readFile(join(fixtureRoot, 'unclassifiable.json'), 'utf8'),
    );
    const fake = await record(TOOLS_ATLAS);
    for (const [name, entry] of Object.entries(contents.mcpServers)) {
      if (name === 'search') continue;
      const file = await projectConfig({
        mcpServers: { search: contents.mcpServers.search, [name]: entry },
      });
      const sarif = join(file.dir, 'must-not-exist.sarif');
      const result = await run([
        'agent-check',
        file.dir,
        '--api-url',
        fake.api,
        '--json',
        '--sarif',
        sarif,
      ]);
      expect(result.code, name).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toContain(
        `MCP server ${name} has no usable url or command`,
      );
      await expect(readFile(sarif)).rejects.toThrow();
    }
    expect(fake.mcpCalls).toHaveLength(0);
    expect(() => parseAgentConfig('fixture', '{"servers":{"":{}}}')).toThrow(
      'unnamed MCP server',
    );
  });

  it.each([
    ['token', { token: 'q!7z' }],
    ['secret', { secret: 'q!7z' }],
    ['password', { password: 'q!7z' }],
    ['api-key', { 'api-key': 'q!7z' }],
    ['env', { env: { API_KEY: 'q!7z' } }],
    ['header', { headers: { Authorization: 'q!7z' } }],
    ['Bearer', { headers: { Custom: 'Bearer q!7z' } }],
    ['Basic', { headers: { Custom: 'Basic q!7z' } }],
    ['arg assignment', { args: ['--token=q!7z'] }],
    ['arg pair', { args: ['--password', 'q!7z'] }],
    ['command', { command: 'node --api_key=q!7z' }],
  ])(
    'still refuses short %s credentials in signed data',
    async (_label, privateFields) => {
      const file = await projectConfig({
        mcpServers: {
          search: { url: 'https://tools.example/mcp' },
          local: { command: 'node', ...privateFields },
        },
      });
      // Fresh modules ensure each case must register its own credential.
      vi.resetModules();
      const { runCli: isolatedRun } = await import('./run');
      let out = '',
        err = '';
      const fake = await record(TOOLS_ATLAS, () => ({
        ...QUIET_TOOL,
        extension: { echo: 'q!7z' },
      }));
      const sarif = join(file.dir, 'must-not-exist.sarif');
      const code = await isolatedRun(
        [
          'agent-check',
          file.dir,
          '--api-url',
          fake.api,
          '--json',
          '--sarif',
          sarif,
        ],
        {
          status: { env: {} },
          stdout: (value) => {
            out += value;
          },
          stderr: (value) => {
            err += value;
          },
        },
      );
      expect(code).toBe(2);
      expect(out).toBe('');
      expect(err).toContain('would contain the credential');
      expect(err).not.toContain('q!7z');
      await expect(readFile(sarif)).rejects.toThrow();
    },
  );

  it('guards even one-character named credentials while allowing ordinary one-character values', async () => {
    for (const field of ['CI', 'API_KEY']) {
      const file = await projectConfig({
        mcpServers: { local: { command: 'node', env: { [field]: '0' } } },
      });
      vi.resetModules();
      const { readAgentConfigs: isolatedRead } = await import('./agent-config');
      const { assertNoSecret, redact } = await import('./secrets');
      await isolatedRead({ config: file.path });
      if (field === 'CI') {
        expect(() =>
          assertNoSecret('2026-11-10T00:00:00Z', 'fixture'),
        ).not.toThrow();
        expect(redact('0')).toBe('0');
      } else {
        expect(() => assertNoSecret('2026-11-10T00:00:00Z', 'fixture')).toThrow(
          'would contain the credential',
        );
        expect(redact('0')).toBe('***');
      }
    }
  });

  it('keeps generic values of eight characters guarded, including their encoded form', async () => {
    const secret = 'h!2q/9$x';
    const file = await projectConfig({
      mcpServers: {
        search: { url: 'https://tools.example/mcp' },
        local: { command: 'node', env: { CUSTOM: secret } },
      },
    });
    const fake = await record(TOOLS_ATLAS, () => ({
      ...QUIET_TOOL,
      extension: { echo: encodeURIComponent(secret) },
    }));
    const result = await run([
      'agent-check',
      file.dir,
      '--api-url',
      fake.api,
      '--json',
    ]);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('would contain the credential');
    expect(result.err).not.toContain(secret);
    expect(result.err).not.toContain(encodeURIComponent(secret));
  });

  it.each([
    '.mcp.json',
    'claude_desktop_config.json',
    '.cursor/mcp.json',
    '.vscode/mcp.json',
    '.vscode/settings.json',
    'local.json',
  ])('reads the %s fixture without retaining private fields', async (name) => {
    const { servers } = await readAgentConfigs({
      config: join(fixtureRoot, name),
    });
    expect(servers.length).toBeGreaterThan(0);
    expect(JSON.stringify(servers)).not.toMatch(
      /fixture-(header|env|arg|local)-token/,
    );
  });

  it('dedupes the directory fixture and refuses malformed/empty fixture configs', async () => {
    expect(
      (await readAgentConfigs({ path: fixtureRoot })).servers,
    ).toHaveLength(2);
    expect(
      (
        await run([
          'agent-check',
          '--config',
          join(fixtureRoot, 'malformed.json'),
        ])
      ).code,
    ).toBe(2);
    expect(
      (await run(['agent-check', '--config', join(fixtureRoot, 'empty.json')]))
        .code,
    ).toBe(2);
  });

  it('keeps table, JSON and SARIF golden outputs with signed extension fields intact', async () => {
    const fake = await record(TOOLS_ATLAS, (name) => ({
      ...(name === 'fetch_page' ? LOUD_TOOL : QUIET_TOOL),
      extension: { preserved: 'unknown signed field', escaped: 'line\nquote"' },
    }));
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(file.dir);
    const sarif = join(file.dir, 'result.sarif');
    const args = ['agent-check', '--config', file.path, '--api-url', fake.api];
    const table = await run([...args, '--sarif', sarif]);
    const json = await run([...args, '--json']);
    expect([table.code, json.code]).toEqual([0, 0]);
    const normalized = (value: string) =>
      value.split(file.path).join('project/.mcp.json');
    await expect(normalized(table.out)).toMatchFileSnapshot(
      './fixtures/agent-check/report.txt',
    );
    await expect(normalized(json.out)).toMatchFileSnapshot(
      './fixtures/agent-check/report.json',
    );
    // SARIF paths and fingerprints must be stable without fixture rewriting.
    const log = JSON.parse(await readFile(sarif, 'utf8'));
    await expect(JSON.stringify(log, null, 2) + '\n').toMatchFileSnapshot(
      './fixtures/agent-check/report.sarif',
    );
    expect(
      JSON.parse(json.out).goalResponses[0].goal.tools[0].extension,
    ).toEqual({ preserved: 'unknown signed field', escaped: 'line\nquote"' });
  });

  it('omits credential-bearing URL components from every output without calling the record', async () => {
    const file = await projectConfig({
      mcpServers: {
        auth: {
          url: 'https://private-user:private-password@tools.example/mcp',
        },
        query: {
          url: 'https://tools.example/mcp?token=private-query#private-fragment',
        },
        invalid: { url: 'private-invalid-url' },
        local: {
          command: '"C:\\Program Files\\node.exe" --token=private-inline-token',
        },
      },
    });
    const fake = await record(TOOLS_ATLAS);
    const sarif = join(file.dir, 'redacted.sarif');
    const result = await run([
      'agent-check',
      '--config',
      file.path,
      '--api-url',
      fake.api,
      '--json',
      '--sarif',
      sarif,
    ]);
    expect(result.code).toBe(0);
    const outputs = result.out + result.err + (await readFile(sarif, 'utf8'));
    expect(outputs).not.toMatch(
      /private-(user|password|query|fragment|invalid-url|inline-token)/,
    );
    expect(JSON.parse(result.out).servers[3].target).toBe('node.exe');
    expect(fake.mcpCalls).toHaveLength(0);
  });

  it.each(['env', 'headers', 'args', 'token'])(
    'refuses %s credential echoes without changing signed data or writing SARIF',
    async (field) => {
      // Includes a quote: checking serialized JSON alone would miss the literal.
      const secret = `fixture-${field}-echo-"agentcheck`;
      const privateValue =
        field === 'headers'
          ? { Authorization: `Bearer ${secret}` }
          : field === 'env'
            ? { TOKEN: secret }
            : field === 'args'
              ? [secret]
              : secret;
      const file = await projectConfig({
        mcpServers: {
          search: { url: 'https://tools.example/mcp', [field]: privateValue },
        },
      });
      const fake = await record(TOOLS_ATLAS, () => ({
        ...QUIET_TOOL,
        extension: { echo: secret },
      }));
      const sarif = join(file.dir, 'must-not-exist.sarif');
      const result = await run([
        'agent-check',
        '--config',
        file.path,
        '--api-url',
        fake.api,
        '--json',
        '--sarif',
        sarif,
      ]);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).not.toContain(secret);
      expect(result.err).toContain('would contain the credential');
      await expect(readFile(sarif)).rejects.toThrow();
    },
  );

  it('guards secrets across config files before sending endpoints or recorded tool names', async () => {
    const secret = 'fixture-cross-config-secret-agentcheck';
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    await write(
      join(file.dir, '.cursor/mcp.json'),
      JSON.stringify({
        mcpServers: { local: { command: 'node', env: { KEY: secret } } },
      }),
    );
    const fake = await record([
      {
        target: 'https://tools.example',
        endpoints: [{ id: 'e', url: 'https://tools.example/mcp' }],
        tools: [{ name: secret, endpointId: 'e' }],
      },
    ]);
    const result = await run([
      'agent-check',
      file.dir,
      '--api-url',
      fake.api,
      '--json',
    ]);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).not.toContain(secret);
    expect(
      fake.mcpCalls.filter(
        (call) => (call.params as { name?: string })?.name === 'check_tools',
      ),
    ).toHaveLength(0);
  });

  it('redacts config labels that duplicate private values, even below eight characters', async () => {
    const secret = 'k7!v';
    const file = await projectConfig({
      mcpServers: { [secret]: { command: 'node', env: { TOKEN: secret } } },
    });
    const result = await run(['agent-check', '--config', file.path, '--json']);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain(secret);
    expect(JSON.parse(result.out).servers[0].name).toBe('***');
  });

  it('finds multiple services on the same ambiguous host', async () => {
    const keys = ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)];
    const file = await projectConfig({
      mcpServers: {
        a: { url: 'https://shared.example/a' },
        b: { url: 'https://shared.example/b' },
      },
    });
    const fake = await record([
      { target: 'https://shared.example', ambiguous: keys },
      ...keys.map((key, i) => ({
        target: key,
        endpoints: [
          { id: 'e', url: `https://shared.example/${i ? 'b' : 'a'}` },
        ],
        tools: [{ name: i ? 'tool_b' : 'tool_a', endpointId: 'e' }],
      })),
    ]);
    const result = await run([
      'agent-check',
      file.dir,
      '--api-url',
      fake.api,
      '--json',
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(
      report.servers.map((server: { status: string }) => server.status),
    ).toEqual(['checked', 'checked']);
    expect(report.summary.checked).toBe(2);
  });

  it.each([
    {},
    { entry: {}, passport: null },
    {
      entry: { origin: 'https://tools.example' },
      passport: { currentPassport: {} },
    },
  ])(
    'treats incomplete atlas success as unavailable, rather than not observed',
    async (full) => {
      const file = await projectConfig({
        mcpServers: { search: { url: 'https://tools.example/mcp' } },
      });
      const fake = await record([{ target: 'https://tools.example', full }]);
      const result = await run([
        'agent-check',
        file.dir,
        '--api-url',
        fake.api,
        '--json',
      ]);
      expect(result.code).toBe(3);
      expect(result.out).toBe('');
      expect(result.err).toContain('incomplete');
    },
  );
});

describe('agent-check record error and summary parity', () => {
  it.each([
    ['INVALID_ARGUMENTS', 2],
    ['SERVICE_UNAVAILABLE', 3],
    ['QUOTA_EXCEEDED', 3],
  ] as const)(
    'handles a released lookup %s error with exit %i',
    async (code, exit) => {
      const file = await projectConfig({
        mcpServers: { search: { url: 'https://tools.example/mcp' } },
      });
      const fake = await record([
        {
          target: 'https://tools.example',
          error: { code, message: 'Record fixture unavailable' },
        },
      ]);
      const result = await run([
        'agent-check',
        file.dir,
        '--api-url',
        fake.api,
      ]);
      expect(result.code).toBe(exit);
      expect(result.out).toBe('');
      expect(result.err).toContain('Record fixture unavailable');
    },
  );

  it('uses returned summary counts when tool flags cannot show an earlier breaking change', async () => {
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    const fake = await record(
      TOOLS_ATLAS,
      () => QUIET_TOOL,
      (goal) => ({
        ...goal,
        summary: { ...goal.summary, breakingSinceStart: 1 },
      }),
    );
    const result = await run([
      'agent-check',
      file.dir,
      '--api-url',
      fake.api,
      '--json',
      '--fail-on',
      'breaking',
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out);
    expect(report.summary.breakingSinceStart).toBe(1);
    expect(
      report.servers[0].tools.every(
        (tool: { breakingSinceStart: boolean }) => !tool.breakingSinceStart,
      ),
    ).toBe(true);
    expect(report.goalResponses[0].goal.summary.breakingSinceStart).toBe(1);
  });

  it('keeps SARIF fingerprints stable when the checkout directory changes', async () => {
    const file = await projectConfig({
      mcpServers: { search: { url: 'https://tools.example/mcp' } },
    });
    const fake = await record(TOOLS_ATLAS, () => LOUD_TOOL);
    const result = await run([
      'agent-check',
      file.dir,
      '--api-url',
      fake.api,
      '--json',
    ]);
    const report = JSON.parse(result.out);
    const original = agentCheckSarif(report, 1000, file.dir);
    report.servers[0].config = '/another/checkout/.mcp.json';
    expect(agentCheckSarif(report, 1000, '/another/checkout')).toEqual(
      original,
    );
  });

  it.each([
    ['.mcp.json', '.mcp.json'],
    ['sub/dir/.cursor/mcp.json', 'sub/dir/.cursor/mcp.json'],
    ['sub dir/config#1?.json', 'sub%20dir/config%231%3F.json'],
  ])(
    'writes identical SARIF at two checkout depths for %s',
    async (configName, expectedUri) => {
      const base = await temp('sarif-depth');
      const fake = await record(TOOLS_ATLAS, () => LOUD_TOOL);
      const cwd = vi.spyOn(process, 'cwd');
      const outputs: string[] = [];
      for (const checkout of [
        join(base, 'checkout'),
        join(base, 'several', 'more', 'levels', 'checkout'),
      ]) {
        const config = await write(
          join(checkout, configName),
          JSON.stringify({
            mcpServers: { search: { url: 'https://tools.example/mcp' } },
          }),
        );
        cwd.mockReturnValue(checkout);
        const sarif = join(checkout, 'result.sarif');
        const result = await run([
          'agent-check',
          '--config',
          config,
          '--api-url',
          fake.api,
          '--sarif',
          sarif,
        ]);
        expect(result.code).toBe(0);
        const output = await readFile(sarif, 'utf8');
        const log = JSON.parse(output);
        expect(log.runs[0].results.length).toBeGreaterThan(0);
        for (const finding of log.runs[0].results)
          expect(
            finding.locations[0].physicalLocation.artifactLocation,
          ).toEqual({
            uri: expectedUri,
          });
        expect(output).not.toContain(base);
        outputs.push(output);
      }
      // Includes the fingerprints, with no output normalization.
      expect(outputs[1]).toBe(outputs[0]);
    },
  );

  it.each(['../user/.cursor/mcp.json', '../checkout-other/.mcp.json'])(
    'keeps facts but omits SARIF locations outside the checkout: %s',
    async (configName) => {
      const base = await temp('sarif-outside');
      const checkout = join(base, 'checkout');
      await mkdir(checkout);
      const config = await write(
        join(checkout, configName),
        JSON.stringify({
          mcpServers: { search: { url: 'http://tools.example/mcp' } },
        }),
      );
      vi.spyOn(process, 'cwd').mockReturnValue(checkout);
      const sarif = join(checkout, 'result.sarif');
      const result = await run([
        'agent-check',
        '--config',
        config,
        '--sarif',
        sarif,
      ]);
      expect(result.code).toBe(0);
      const output = await readFile(sarif, 'utf8');
      const log = JSON.parse(output);
      expect(log.runs[0].results).toHaveLength(1);
      expect(log.runs[0].results[0].ruleId).toBe(
        'AGENT_CHECK_SERVER_NOT_CHECKABLE',
      );
      expect(log.runs[0].results[0]).not.toHaveProperty('locations');
      expect(output).not.toContain(base);
      expect(output).not.toContain('..');
    },
  );

  it.each(['not_observed', 'removed', 'requires_sign_in'])(
    'reports a returned %s tool without inventing effects/payment facts',
    async (status) => {
      const file = await projectConfig({
        mcpServers: { search: { url: 'https://tools.example/mcp' } },
      });
      const fake = await record(TOOLS_ATLAS, () => ({ ...QUIET_TOOL, status }));
      const result = await run([
        'agent-check',
        file.dir,
        '--api-url',
        fake.api,
        '--json',
        '--fail-on',
        'not_observed',
      ]);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.out);
      expect(report.summary.notObserved).toBe(2);
      expect(report.servers[0].tools[0]).toMatchObject({
        status,
        changed: false,
        asksForPayment: false,
        movesMoney: false,
        deletes: false,
        sendsMessages: false,
      });
    },
  );
});

describe('config labels are separate from credential fields', () => {
  it('checks a server named with token/secret words without treating its endpoint as a credential', async () => {
    const file = await projectConfig({
      mcpServers: {
        'secret-token-tools': { url: 'https://tools.example/mcp' },
      },
    });
    const fake = await record(TOOLS_ATLAS);
    const result = await run([
      'agent-check',
      file.dir,
      '--api-url',
      fake.api,
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).servers[0]).toMatchObject({
      name: 'secret-token-tools',
      status: 'checked',
    });
  });
});
