import { isAbsolute, relative } from 'node:path';
import {
  displayAgentUrl,
  readAgentConfigs,
  type AgentConfigServer,
} from './agent-config';
export {
  parseAgentConfig,
  PROJECT_CONFIG_FILES,
  readAgentConfigs,
  userConfigPaths,
  type AgentConfigOptions,
  type AgentConfigServer,
} from './agent-config';
import { canonicalSha256 } from '@interfacedelta/core';
import { ConfigurationError, InspectionError } from './errors';
import { machineJson } from './format';
import { assertNoSecret, redact, registerSecret } from './secrets';
import { sanitizeTerminal } from './sanitize';
import {
  apiBase,
  atOrAfter,
  goal as parseGoal,
  keyless,
  parse,
  payload,
  request,
  recordMcpHandshake,
  statusSince,
  type Goal,
  type CheckToolInput,
  type StatusEnvironment,
} from './record-client';
import { CLI_VERSION } from './types';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const href = (value: string): string => new URL(value).href;

/** Check original strings, before JSON escaping could hide a credential. */
function assertData(value: unknown, label: string): void {
  if (typeof value === 'string') assertNoSecret(value, label);
  else if (Array.isArray(value))
    value.forEach((item) => assertData(item, label));
  else
    for (const [key, child] of Object.entries(object(value))) {
      assertNoSecret(key, label);
      assertData(child, label);
    }
}

/** Conditions for --fail-on, each backed by a returned summary count. */
export const AGENT_CHECK_FAIL_ON = [
  'breaking',
  'changed',
  'stale',
  'payment',
  'money',
  'not_observed',
] as const;
export type AgentFailCondition = (typeof AGENT_CHECK_FAIL_ON)[number];

export function parseAgentFailOn(value?: string): AgentFailCondition[] {
  if (!value?.trim()) return [];
  const tokens = [
    ...new Set(
      value
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];
  if (!tokens.length)
    throw new ConfigurationError(
      `--fail-on accepts ${AGENT_CHECK_FAIL_ON.join(', ')}.`,
    );
  const invalid = tokens.filter(
    (token) => !(AGENT_CHECK_FAIL_ON as readonly string[]).includes(token),
  );
  if (invalid.length)
    throw new ConfigurationError(
      `--fail-on accepts ${AGENT_CHECK_FAIL_ON.join(', ')}.`,
    );
  return tokens as AgentFailCondition[];
}

const KEY_HINT =
  'Get a free key with one request: POST https://interfacedelta.com/api/v1/agent-keys. Set INTERFACEDELTA_AGENT_KEY to the returned key.';
const KEYLESS_TOOL_LIMIT = 5;
const REST_BATCH = 50;
const AMBIGUOUS_TARGET_LIMIT = 5;
const CAUTION =
  'No recorded change is not proof of no change. Tool lines show the latest breaking change; goal counts include earlier recorded breaking changes.';

type ToolCallResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { code: string; message: string; candidates: unknown[] };
    };

/** One released read-only tool on /mcp/public; no key, no Record Check quota. */
async function publicToolCall(
  env: StatusEnvironment,
  base: URL,
  name: string,
  args: unknown,
): Promise<ToolCallResult> {
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
          params: { name, arguments: args },
        },
        { ...headers, 'mcp-method': 'tools/call', 'mcp-name': name },
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
  const error = object(value.error ?? structured.error);
  if (result.isError || structured.ok === false || error.code || error.message)
    return {
      ok: false,
      error: {
        code: String(error.code ?? ''),
        message: String(error.message ?? ''),
        candidates: Array.isArray(error.candidates) ? error.candidates : [],
      },
    };
  return { ok: true, value: value.result ?? structured.result ?? value };
}

type EndpointTools = { endpoint: string; tools: string[] };

/** The retained Passport's MCP endpoints and each endpoint's recorded tools. */
function recordedEndpoints(full: Record<string, unknown>): {
  endpoints: Map<string, EndpointTools>;
  firstObservedAt?: string;
} {
  if (
    !Object.keys(object(full.entry)).length ||
    !Object.hasOwn(full, 'passport')
  )
    throw new InspectionError('The record returned an incomplete atlas entry.');
  const current = object(object(full.passport).currentPassport);
  if (
    full.passport !== null &&
    (!Array.isArray(current.endpoints) || !Array.isArray(current.capabilities))
  )
    throw new InspectionError('The record returned an incomplete Passport.');
  const endpointsById = new Map<string, string>();
  for (const endpoint of Array.isArray(current.endpoints)
    ? current.endpoints
    : []) {
    const item = object(endpoint);
    if (item.protocol === 'mcp' && typeof item.url === 'string')
      endpointsById.set(String(item.id), item.url);
  }
  const toolsByEndpoint = new Map<string, string[]>();
  for (const endpoint of endpointsById.values())
    toolsByEndpoint.set(endpoint, []);
  for (const capability of Array.isArray(current.capabilities)
    ? current.capabilities
    : []) {
    const item = object(capability);
    if (
      item.kind !== 'mcp.tool' ||
      typeof item.name !== 'string' ||
      item.name.length < 1 ||
      item.name.length > 128
    )
      continue;
    const url = endpointsById.get(String(item.sourceEndpointId));
    if (!url) continue;
    const tools = toolsByEndpoint.get(url) ?? [];
    if (!tools.includes(item.name)) tools.push(item.name);
    toolsByEndpoint.set(url, tools);
  }
  const endpoints = new Map<string, EndpointTools>();
  for (const [url, tools] of toolsByEndpoint)
    if (href(url).startsWith('https://'))
      endpoints.set(href(url), { endpoint: url, tools });
  const entry = object(full.entry);
  let firstObservedAt: string | undefined;
  if (Object.hasOwn(entry, 'observations')) {
    if (
      !Array.isArray(entry.observations) ||
      entry.observations.some((observation) => {
        const at = object(observation).observedAt;
        return typeof at !== 'string' || !Number.isFinite(Date.parse(at));
      })
    )
      throw new InspectionError(
        'The record returned an incomplete atlas entry.',
      );
    // Retained observations are newest-first. An empty history has no start;
    // it must never silently substitute the newest observation's timestamp.
    firstObservedAt = object(entry.observations.at(-1)).observedAt as
      string | undefined;
  } else if (typeof entry.lastObservedAt === 'string')
    firstObservedAt = entry.lastObservedAt;
  return { endpoints, firstObservedAt };
}

type RemoteServer = Extract<AgentConfigServer, { kind: 'remote' }>;
type Lookup =
  | {
      kind: 'found';
      endpoints: Map<string, EndpointTools>;
      firstObservedAt?: string;
    }
  | { kind: 'not_observed' };

type LookupCall =
  | { kind: 'found'; full: Record<string, unknown> }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; keys: string[] }
  | { kind: 'refused'; message: string }
  | { kind: 'unavailable'; message: string };

function foundFrom(
  full: Record<string, unknown>,
  urls: readonly string[],
): Lookup {
  const { endpoints, firstObservedAt } = recordedEndpoints(full);
  return urls.some((url) => endpoints.has(href(url)))
    ? { kind: 'found', endpoints, firstObservedAt }
    : { kind: 'not_observed' };
}

/**
 * Step A of every server: `get_atlas_entry` with view "full" on /mcp/public,
 * the released read-only tool whose retained Passport is the only public
 * place an endpoint's recorded capabilities (endpoint URLs plus each tool's
 * sourceEndpointId) appear. The configured endpoint's origin is the target;
 * an ambiguous host is resolved by trying the record's candidate target keys.
 */
async function atlasLookup(
  env: StatusEnvironment,
  base: URL,
  origin: string,
  urls: readonly string[],
): Promise<Lookup> {
  const fetchFull = async (target: string): Promise<LookupCall> => {
    const call = await publicToolCall(env, base, 'get_atlas_entry', {
      target,
      view: 'full',
    });
    if (call.ok) return { kind: 'found', full: object(call.value) };
    const { code, message, candidates } = call.error;
    if (code === 'NOT_FOUND') return { kind: 'not_found' };
    if (code === 'AMBIGUOUS_TARGET')
      return {
        kind: 'ambiguous',
        keys: [
          ...new Set(
            candidates
              .map((item) => object(item).targetKey)
              .filter(
                (key): key is string =>
                  typeof key === 'string' && /^sha256:[a-f0-9]{64}$/.test(key),
              ),
          ),
        ].slice(0, AMBIGUOUS_TARGET_LIMIT),
      };
    if (code === 'INVALID_ARGUMENTS')
      return { kind: 'refused', message: `${message || code}` };
    return { kind: 'unavailable', message: `${message || code}` };
  };
  const direct = await fetchFull(origin);
  if (direct.kind === 'found') return foundFrom(direct.full, urls);
  if (direct.kind === 'not_found') return { kind: 'not_observed' };
  if (direct.kind === 'refused')
    throw new ConfigurationError(
      `Record MCP refused the lookup: ${sanitizeTerminal(direct.message)}`,
    );
  if (direct.kind === 'unavailable')
    throw new InspectionError(
      `Record lookup unavailable: ${sanitizeTerminal(direct.message)}`,
    );
  const matches = new Map<string, EndpointTools>();
  const starts: string[] = [];
  for (const key of direct.keys) {
    const candidate = await fetchFull(key);
    if (candidate.kind === 'refused')
      throw new ConfigurationError(
        `Record MCP refused the lookup: ${sanitizeTerminal(candidate.message)}`,
      );
    if (candidate.kind === 'unavailable')
      throw new InspectionError(
        `Record lookup unavailable: ${sanitizeTerminal(candidate.message)}`,
      );
    if (candidate.kind !== 'found') continue;
    const lookup = foundFrom(candidate.full, urls);
    if (lookup.kind === 'found') {
      for (const [url, endpoint] of lookup.endpoints) {
        if (
          matches.has(url) &&
          JSON.stringify(matches.get(url)?.tools) !==
            JSON.stringify(endpoint.tools)
        )
          throw new InspectionError(
            'Several recorded services disagree on this endpoint.',
          );
        matches.set(url, endpoint);
      }
      if (lookup.firstObservedAt) starts.push(lookup.firstObservedAt);
    }
  }
  if (urls.every((url) => matches.has(href(url))))
    return {
      kind: 'found',
      endpoints: matches,
      firstObservedAt: starts.sort()[0],
    };
  if (direct.keys.length === AMBIGUOUS_TARGET_LIMIT)
    throw new InspectionError(
      'The record has more candidate services than this lookup can resolve.',
    );
  if (matches.size)
    return {
      kind: 'found',
      endpoints: matches,
      firstObservedAt: starts.sort()[0],
    };
  return { kind: 'not_observed' };
}

export type ToolReport = {
  name: string;
  status:
    | 'observed'
    | 'not_observed'
    | 'removed'
    | 'requires_sign_in'
    | 'not_checked';
  changed: boolean;
  breakingSinceStart: boolean;
  stale: boolean;
  asksForPayment: boolean;
  declaredPaid: boolean;
  movesMoney: boolean;
  deletes: boolean;
  sendsMessages: boolean;
  /** The signed Record Check answer for this tool, complete and unmodified. */
  check?: unknown;
};

export type ServerReport = {
  name: string;
  config: string;
  kind: 'remote' | 'stdio';
  status: 'checked' | 'not_observed' | 'not_checkable' | 'not_checkable_local';
  /** Display URL without userinfo/query/fragment (remote), or command basename. */
  target: string;
  reason?: string;
  /** The recorded endpoint URL the tools were checked against. */
  recordedEndpoint?: string;
  firstObservedAt?: string;
  tools?: ToolReport[];
};

export type AgentCheckReport = {
  formatVersion: 'interfacedelta-agent-check-v1';
  cliVersion: string;
  configs: string[];
  sinceTime: string | null;
  sinceSource: '--since' | 'first-observed';
  transport: 'mcp-public' | 'rest';
  keylessLimit: {
    limit: number;
    checked: number;
    unchecked: number;
  } | null;
  summary: Goal['summary'];
  servers: ServerReport[];
  /** Every signed goal response, parsed and complete, in request order. */
  goalResponses: {
    transport: 'mcp-public' | 'rest';
    goal: unknown;
    quota?: unknown;
  }[];
};

export type AgentCheckOutcome = {
  report: AgentCheckReport;
  human: string;
  json: string;
  sarif: string;
  exitCode: number;
};

export type AgentCheckOptions = {
  path?: string;
  config?: string;
  includeUserConfigs?: boolean;
  since?: string;
  failOn?: string;
  apiUrl?: string;
};

function toolFacts(tool: ToolReport): string[] {
  if (tool.status === 'not_checked')
    return ['not checked (keyless limit; set INTERFACEDELTA_AGENT_KEY)'];
  if (tool.status !== 'observed')
    return [
      'not observed by InterfaceDelta',
      ...(tool.status === 'removed'
        ? ['removed from record']
        : tool.status === 'requires_sign_in'
          ? ['requires sign-in']
          : []),
    ];
  const facts: string[] = [];
  if (tool.breakingSinceStart)
    facts.push('breaking since start (latest recorded change)');
  if (tool.changed) facts.push('changed');
  if (tool.stale) facts.push('stale');
  if (tool.asksForPayment) facts.push('asks for payment (HTTP 402 observed)');
  if (tool.declaredPaid) facts.push('declared paid');
  if (tool.movesMoney) facts.push('moves money (stored AI reading)');
  if (tool.deletes) facts.push('deletes (stored AI reading)');
  if (tool.sendsMessages) facts.push('sends messages (stored AI reading)');
  return facts.length ? facts : ['no change recorded since start'];
}

export function formatAgentCheck(report: AgentCheckReport): string {
  const lines: string[] = [
    'InterfaceDelta agent-check',
    '',
    `Config: ${report.configs.map((path) => sanitizeTerminal(path, 300)).join(', ')}`,
    `Start: ${report.sinceTime ?? 'not supplied'} (${report.sinceSource === '--since' ? '--since' : 'earliest retained observation'})`,
    '',
  ];
  const rows: [string, string][] = [];
  for (const server of report.servers) {
    const label =
      server.kind === 'stdio'
        ? `${sanitizeTerminal(server.name, 100)} (stdio)`
        : `${sanitizeTerminal(server.target, 150)} (${sanitizeTerminal(server.name, 100)})`;
    if (server.kind === 'stdio')
      rows.push([
        label,
        `not checkable locally (command: ${sanitizeTerminal(server.target, 100)})`,
      ]);
    else if (server.status === 'not_observed')
      rows.push([label, 'not observed by InterfaceDelta']);
    else if (server.status === 'not_checkable')
      rows.push([
        label,
        `not checkable: ${sanitizeTerminal(server.reason, 300)}`,
      ]);
    else if (!server.tools?.length) rows.push([label, 'no recorded tools']);
    else
      for (const tool of server.tools)
        rows.push([
          label,
          `${sanitizeTerminal(tool.name, 128)}: ${toolFacts(tool).join('; ')}`,
        ]);
  }
  const width = rows.reduce(
    (maximum, [label]) => Math.max(maximum, label.length),
    'Server'.length,
  );
  lines.push(
    `${'Server'.padEnd(width)} | Recorded tools / facts`,
    `${'-'.repeat(width)}-+-----------------------`,
  );
  for (const [label, facts] of rows)
    lines.push(`${label.padEnd(width)} | ${facts}`);
  if (report.keylessLimit)
    lines.push(
      '',
      `Keyless check covers the first ${report.keylessLimit.checked} of ${report.keylessLimit.checked + report.keylessLimit.unchecked} tools; set INTERFACEDELTA_AGENT_KEY to check the rest. ${KEY_HINT}`,
    );
  const s = report.summary;
  lines.push(
    '',
    `Goal: ${s.checked} checked; ${s.changedSinceStart} changed; ${s.breakingSinceStart} breaking since start; ${s.notObserved} not observed; ${s.stale} stale; ${s.asksForPayment} asks for payment; ${s.declaredPaid ?? 'not supplied'} declared paid; ${s.movesMoneyOrDeletes} moves money or deletes.`,
    CAUTION,
    'Details: https://interfacedelta.com/atlas',
  );
  return `${lines.join('\n')}\n`;
}

const SARIF_RULES = {
  breaking: ['AGENT_CHECK_BREAKING_SINCE_START', 'error'],
  changed: ['AGENT_CHECK_CHANGED', 'warning'],
  stale: ['AGENT_CHECK_STALE', 'note'],
  payment: ['AGENT_CHECK_ASKS_FOR_PAYMENT', 'warning'],
  declaredPaid: ['AGENT_CHECK_DECLARED_PAID', 'note'],
  movesMoney: ['AGENT_CHECK_MOVES_MONEY', 'warning'],
  deletes: ['AGENT_CHECK_DELETES', 'warning'],
  sendsMessages: ['AGENT_CHECK_SENDS_MESSAGES', 'note'],
  notObserved: ['AGENT_CHECK_NOT_OBSERVED', 'note'],
  removed: ['AGENT_CHECK_REMOVED', 'note'],
  requiresSignIn: ['AGENT_CHECK_REQUIRES_SIGN_IN', 'note'],
  notChecked: ['AGENT_CHECK_NOT_CHECKED', 'warning'],
} as const;

/** SARIF 2.1.0 for the Action's agent-check mode: facts as results, never verdicts. */
export function agentCheckSarif(
  report: AgentCheckReport,
  limit = 1000,
  repositoryRoot = process.cwd(),
): Record<string, unknown> {
  const rules = new Map<string, { id: string; level: string }>();
  const results: Record<string, unknown>[] = [];
  let omitted = 0;
  const push = (
    config: string,
    rule: { id: string; level: string },
    message: string,
    fingerprint: unknown,
  ) => {
    if (results.length >= limit) {
      omitted++;
      return;
    }
    rules.set(
      rule.id,
      rules.get(rule.id) ?? {
        id: rule.id,
        level: rule.level,
      },
    );
    const configPath = relative(repositoryRoot, config);
    const segments = configPath.split(/[\\/]/);
    // User configs may live outside the checkout. Keep their facts, but never
    // anchor them to a parent traversal or an absolute machine-specific path.
    const uri =
      configPath && !isAbsolute(configPath) && !segments.includes('..')
        ? segments.map(encodeURIComponent).join('/')
        : undefined;
    results.push({
      ruleId: rule.id,
      level: rule.level,
      message: { text: sanitizeTerminal(message, 500) },
      ...(uri
        ? {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri },
                  region: { startLine: 1 },
                },
              },
            ],
          }
        : {}),
      partialFingerprints: {
        'interfacedeltaAgentCheck/v1': canonicalSha256({
          ...object(fingerprint),
          config: uri ?? null,
        }),
      },
    });
  };
  for (const server of report.servers) {
    if (server.kind === 'stdio') continue;
    if (server.status === 'not_observed') {
      push(
        server.config,
        { id: 'AGENT_CHECK_SERVER_NOT_OBSERVED', level: 'note' },
        `${server.target}: not observed by InterfaceDelta`,
        {
          config: server.config,
          endpoint: server.target,
          fact: 'server_not_observed',
        },
      );
      continue;
    }
    if (server.status === 'not_checkable') {
      push(
        server.config,
        { id: 'AGENT_CHECK_SERVER_NOT_CHECKABLE', level: 'note' },
        `${server.target}: ${server.reason ?? 'not checkable'}`,
        {
          config: server.config,
          endpoint: server.target,
          fact: 'server_not_checkable',
        },
      );
      continue;
    }
    for (const tool of server.tools ?? []) {
      const facts: [keyof typeof SARIF_RULES, boolean, string][] = [
        [
          'breaking',
          tool.breakingSinceStart,
          'breaking since start (latest recorded change)',
        ],
        ['changed', tool.changed, 'changed'],
        ['stale', tool.stale, 'stale'],
        [
          'payment',
          tool.asksForPayment,
          'asks for payment (HTTP 402 observed)',
        ],
        ['declaredPaid', tool.declaredPaid, 'declared paid'],
        ['movesMoney', tool.movesMoney, 'moves money (stored AI reading)'],
        ['deletes', tool.deletes, 'deletes (stored AI reading)'],
        [
          'sendsMessages',
          tool.sendsMessages,
          'sends messages (stored AI reading)',
        ],
        ['removed', tool.status === 'removed', 'removed from record'],
        [
          'requiresSignIn',
          tool.status === 'requires_sign_in',
          'requires sign-in',
        ],
        [
          'notObserved',
          tool.status === 'not_observed',
          'not observed by InterfaceDelta',
        ],
        [
          'notChecked',
          tool.status === 'not_checked',
          'not checked (keyless limit; set INTERFACEDELTA_AGENT_KEY)',
        ],
      ];
      for (const [key, present, text] of facts)
        if (present)
          push(
            server.config,
            {
              id: SARIF_RULES[key][0],
              level: SARIF_RULES[key][1],
            },
            `${server.target} ${tool.name}: ${text}`,
            {
              config: server.config,
              endpoint: server.target,
              tool: tool.name,
              fact: key,
            },
          );
    }
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        automationDetails: { id: 'interfacedelta-agent-check/' },
        tool: {
          driver: {
            name: 'InterfaceDelta',
            version: CLI_VERSION,
            informationUri: 'https://interfacedelta.com/docs',
            rules: [...rules.values()]
              .sort((a, b) => a.id.localeCompare(b.id, 'en'))
              .map((rule) => ({
                id: rule.id,
                shortDescription: {
                  text: `InterfaceDelta agent check: ${rule.id.toLowerCase().replace(/_/g, ' ').replace('agent check ', '')}`,
                },
                properties: { level: rule.level },
              })),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: omitted
              ? [
                  {
                    level: 'warning',
                    message: { text: `${omitted} additional results omitted.` },
                  },
                ]
              : [],
          },
        ],
        results,
      },
    ],
  };
}

const notCheckedTool = (name: string): ToolReport => ({
  name,
  status: 'not_checked',
  changed: false,
  breakingSinceStart: false,
  stale: false,
  asksForPayment: false,
  declaredPaid: false,
  movesMoney: false,
  deletes: false,
  sendsMessages: false,
});

export async function runAgentCheck(
  options: AgentCheckOptions,
  env: StatusEnvironment,
): Promise<AgentCheckOutcome> {
  const base = apiBase(options.apiUrl);
  // Validate every argument before the first network request.
  const since =
    options.since === undefined ? undefined : statusSince(options.since);
  const conditions = parseAgentFailOn(options.failOn);
  const { configs, servers } = await readAgentConfigs(options);
  if (!servers.length)
    throw new ConfigurationError(
      `No MCP servers found in ${configs.map((path) => sanitizeTerminal(path, 200)).join(', ')}.`,
    );
  const key = env.env.INTERFACEDELTA_AGENT_KEY?.trim();
  if (key) registerSecret(key);

  assertNoSecret(base.href, 'record URL');

  const remote: RemoteServer[] = [];
  const reports: ServerReport[] = [];
  const reportFor = new Map<RemoteServer, ServerReport>();
  for (const server of servers) {
    if (server.kind === 'stdio') {
      reports.push({
        name: redact(server.name),
        config: redact(server.config),
        kind: 'stdio',
        status: 'not_checkable_local',
        target: redact(server.command),
      });
      continue;
    }
    let url: URL | undefined;
    try {
      url = new URL(server.url);
    } catch {
      url = undefined;
    }
    const reason = !url
      ? 'not a valid URL'
      : url.protocol !== 'https:'
        ? 'Record Check covers HTTPS endpoints only'
        : url.username || url.password
          ? 'URLs with credentials cannot be checked'
          : url.search || url.hash
            ? 'URLs with a query or fragment cannot be checked'
            : server.url.length > 2048
              ? 'URLs longer than 2048 characters cannot be checked'
              : /\$\{|%24%7B/i.test(server.url)
                ? 'URLs with variable references cannot be checked'
                : undefined;
    const report: ServerReport = {
      name: redact(server.name),
      config: redact(server.config),
      kind: 'remote',
      status: reason ? 'not_checkable' : 'not_observed',
      target: displayAgentUrl(server.url),
      ...(reason ? { reason } : {}),
    };
    reports.push(report);
    if (!reason) {
      remote.push(server);
      reportFor.set(server, report);
    }
  }

  // One record lookup per origin; each configured endpoint picks its match.
  const byOrigin = new Map<string, RemoteServer[]>();
  for (const server of remote) {
    const origin = new URL(server.url).origin;
    const group = byOrigin.get(origin) ?? [];
    group.push(server);
    byOrigin.set(origin, group);
  }
  const matched = new Map<
    RemoteServer,
    { endpoint: string; tools: string[]; firstObservedAt?: string }
  >();
  for (const [origin, group] of byOrigin) {
    assertNoSecret(origin, 'record lookup');
    const lookup = await atlasLookup(
      env,
      base,
      origin,
      group.map((server) => server.url),
    );
    if (lookup.kind !== 'found') continue;
    for (const server of group) {
      const entry = lookup.endpoints.get(href(server.url));
      if (entry)
        matched.set(server, {
          endpoint: entry.endpoint,
          tools: entry.tools,
          firstObservedAt: lookup.firstObservedAt,
        });
    }
  }

  const firstObserved = [...matched.values()]
    .map((entry) => entry.firstObservedAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const sinceTime = since ?? firstObserved ?? null;

  const queue: { server: RemoteServer; tool: string }[] = [];
  for (const server of remote) {
    const entry = matched.get(server);
    if (entry) for (const tool of entry.tools) queue.push({ server, tool });
  }
  const limit =
    !key && queue.length > KEYLESS_TOOL_LIMIT
      ? {
          limit: KEYLESS_TOOL_LIMIT,
          checked: KEYLESS_TOOL_LIMIT,
          unchecked: queue.length - KEYLESS_TOOL_LIMIT,
        }
      : null;
  const checkedQueue = limit ? queue.slice(0, KEYLESS_TOOL_LIMIT) : queue;
  const skipped = limit ? queue.slice(KEYLESS_TOOL_LIMIT) : [];

  const summary: Goal['summary'] = {
    checked: 0,
    changedSinceStart: 0,
    breakingSinceStart: 0,
    notObserved: 0,
    stale: 0,
    movesMoneyOrDeletes: 0,
    asksForPayment: 0,
    declaredPaid: 0,
  };
  const goalResponses: AgentCheckReport['goalResponses'] = [];
  const checks = new Map<string, unknown>();
  const flags = new Map<string, Goal['tools'][number]>();
  const batches: CheckToolInput[][] = [];
  if (checkedQueue.length) {
    const toTools = (slice: { server: RemoteServer; tool: string }[]) =>
      slice.map(({ server, tool }) => ({
        endpoint: matched.get(server)!.endpoint,
        tool,
        ...(sinceTime ? { sinceTime } : {}),
      }));
    if (key)
      for (let offset = 0; offset < checkedQueue.length; offset += REST_BATCH)
        batches.push(toTools(checkedQueue.slice(offset, offset + REST_BATCH)));
    else batches.push(toTools(checkedQueue));
  }
  for (const batch of batches) {
    assertData(payload(batch), 'record request');
    // Step B: the same check_tools goal, batching and limits as `status`.
    const response = key
      ? await (async () => {
          const raw = await request(
            env,
            new URL('/api/v1/record/check/goal', base),
            payload(batch),
            { authorization: `Bearer ${key}` },
          );
          const parsed = object(parse(raw));
          return {
            transport: 'rest' as const,
            goal: parseGoal(parsed, batch.length),
            embed: parsed,
            rawTools: Array.isArray(parsed.tools) ? parsed.tools : [],
          };
        })()
      : await (async () => {
          const result = await keyless(env, base, batch);
          const parsed = object(parse(result.raw));
          const signed = object(parsed.result);
          return {
            transport: 'mcp-public' as const,
            goal: parseGoal(signed, batch.length),
            embed: signed,
            rawTools: Array.isArray(signed.tools) ? signed.tools : [],
            quota: parsed.quota,
          };
        })();
    goalResponses.push({
      transport: response.transport,
      goal: response.embed,
      ...(response.transport === 'mcp-public'
        ? { quota: object(response.quota) }
        : {}),
    });
    response.goal.tools.forEach((tool, index) => {
      const input = batch[index]!;
      const id = `${input.endpoint}#${input.tool}`;
      if (response.rawTools[index] !== undefined)
        checks.set(id, response.rawTools[index]);
      flags.set(id, tool);
    });
    // Only sum the server's counts; never reconstruct counts from tool flags.
    for (const field of [
      'checked',
      'changedSinceStart',
      'breakingSinceStart',
      'notObserved',
      'stale',
      'movesMoneyOrDeletes',
      'asksForPayment',
    ] as const)
      summary[field] += response.goal.summary[field];
    if (
      summary.declaredPaid !== undefined &&
      response.goal.summary.declaredPaid !== undefined
    )
      summary.declaredPaid += response.goal.summary.declaredPaid;
    else delete summary.declaredPaid;
  }

  const toolReport = (name: string, endpoint: string): ToolReport => {
    const tool = flags.get(`${endpoint}#${name}`);
    if (!tool) return notCheckedTool(name);
    const observed = tool.status === 'observed';
    const lastAt = tool.change?.last?.at;
    return {
      name,
      status: tool.status,
      changed: Boolean(tool.changedSinceTime || tool.change?.changedSince),
      breakingSinceStart: Boolean(
        observed &&
        tool.change?.last?.class === 'breaking' &&
        lastAt &&
        sinceTime &&
        atOrAfter(lastAt, sinceTime),
      ),
      stale: Boolean(observed && tool.observed?.stale),
      asksForPayment: Boolean(observed && tool.payment?.requiresPayment),
      declaredPaid: Boolean(
        observed && tool.payment?.declared?.state === 'declared_paid',
      ),
      movesMoney: Boolean(
        observed &&
        tool.effects?.classes.some(
          (effect) => effect.class === 'moves_money' && effect.p >= 0.5,
        ),
      ),
      deletes: Boolean(
        observed &&
        tool.effects?.classes.some(
          (effect) => effect.class === 'deletes' && effect.p >= 0.5,
        ),
      ),
      sendsMessages: Boolean(
        observed &&
        tool.effects?.classes.some(
          (effect) => effect.class === 'sends_messages' && effect.p >= 0.5,
        ),
      ),
      ...(checks.has(`${endpoint}#${name}`)
        ? { check: checks.get(`${endpoint}#${name}`) }
        : {}),
    };
  };

  const skippedIds = new Set(
    skipped.map(
      ({ server, tool }) => `${matched.get(server)!.endpoint}#${tool}`,
    ),
  );
  for (const server of remote) {
    const entry = matched.get(server);
    if (!entry) continue;
    const report = reportFor.get(server)!;
    report.status = 'checked';
    report.recordedEndpoint = entry.endpoint;
    if (entry.firstObservedAt) report.firstObservedAt = entry.firstObservedAt;
    report.tools = entry.tools.map((name) =>
      skippedIds.has(`${entry.endpoint}#${name}`)
        ? notCheckedTool(name)
        : toolReport(name, entry.endpoint),
    );
  }

  const report: AgentCheckReport = {
    formatVersion: 'interfacedelta-agent-check-v1',
    cliVersion: CLI_VERSION,
    configs: configs.map(redact),
    sinceTime,
    sinceSource: since !== undefined ? '--since' : 'first-observed',
    transport: key ? 'rest' : 'mcp-public',
    keylessLimit: limit,
    summary,
    servers: reports,
    goalResponses,
  };
  const serverNotObserved = reports.some(
    (server) => server.status === 'not_observed',
  );
  const matchedCondition = conditions.some((condition) =>
    condition === 'breaking'
      ? summary.breakingSinceStart > 0
      : condition === 'changed'
        ? summary.changedSinceStart > 0
        : condition === 'stale'
          ? summary.stale > 0
          : condition === 'payment'
            ? summary.asksForPayment > 0
            : condition === 'money'
              ? summary.movesMoneyOrDeletes > 0
              : summary.notObserved > 0 || serverNotObserved,
  );
  // Preserve signed answers exactly; refuse an echoed credential instead of
  // redacting signed data and silently invalidating its signature.
  assertData(report, 'agent-check report');
  return {
    report,
    human: formatAgentCheck(report),
    json: machineJson(report),
    sarif: machineJson(agentCheckSarif(report)),
    exitCode: matchedCondition ? 1 : 0,
  };
}
