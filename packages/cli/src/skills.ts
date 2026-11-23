import { dirname, resolve } from 'node:path';
import { ConfigurationError, InspectionError } from './errors';
import { writeAtomic } from './io';
import {
  DEFAULT_LIKELY_USES_LIMITS,
  matchesWholeIdentifier,
  readCandidate,
  validateScanRoot,
} from './likely-uses';
import { sanitizeTerminal } from './sanitize';
import { assertNoSecret } from './secrets';
import {
  scanSkillFiles,
  skillFileMatcher,
  type SkillFileOptions,
} from './skill-files';
import {
  checkStatusTools,
  statusAtOrAfter,
  statusInputs,
  statusSince,
  type InputTool,
  type StatusEnvironment,
  type StatusGoal,
} from './status';
import { CLI_VERSION } from './types';

export const SKILLS_REASONS = [
  'tool_changed_since',
  'breaking_change',
  'tool_removed',
  'input_not_recorded',
  'asks_for_payment',
  'not_observed',
] as const;
export type SkillsReason = (typeof SKILLS_REASONS)[number];
export type SkillMention = {
  path: string;
  line: number;
  term: string;
  tool: string;
  endpoint: string;
  why: SkillsReason[];
};
export type SkillsReport = {
  formatVersion: 'interfacedelta-skills-v1';
  truncated: boolean;
  filesRead: number;
  bytesRead: number;
  checked: InputTool[];
  mentions: SkillMention[];
  /** Each exact REST response or keyless MCP result JSON, including signatures. */
  signedAnswers: string[];
};

export function skillsFailOn(value?: string): SkillsReason[] {
  if (value === undefined) return [];
  const values = value.split(',').map((item) => item.trim());
  if (
    !values.length ||
    values.some((item) => !SKILLS_REASONS.includes(item as SkillsReason))
  )
    throw new ConfigurationError(
      `--fail-on must list: ${SKILLS_REASONS.join(', ')}.`,
    );
  return [...new Set(values)] as SkillsReason[];
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
    : [];

/** Only URL fields are used. Never reads env/headers/args or executes a server. */
export async function skillConfigEndpoints(file: string): Promise<string[]> {
  let config: Record<string, unknown>;
  try {
    const path = resolve(file);
    const root = await validateScanRoot(dirname(path));
    const result = await readCandidate(root, path, 1024 * 1024);
    if (result.content === undefined || result.truncated) throw new Error();
    config = object(JSON.parse(result.content));
  } catch {
    throw new ConfigurationError(
      'MCP config must be readable JSON, at most 1 MiB, without symlinks.',
    );
  }
  if (config.mcpServers !== undefined && config.servers !== undefined)
    throw new ConfigurationError(
      'MCP config must use either mcpServers or servers, not both.',
    );
  const servers = object(config.mcpServers ?? config.servers);
  const endpoints: string[] = [];
  for (const server of Object.values(servers)) {
    const entry = object(server);
    const value = entry.url;
    if (value === undefined) {
      if (typeof entry.command === 'string' && entry.command.trim()) continue;
      throw new ConfigurationError(
        'Each MCP server must be an object with a URL or a stdio command.',
      );
    }
    try {
      if (typeof value !== 'string') throw new Error();
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      endpoints.push(url.href);
    } catch {
      // Never echo a config URL: it could contain a credential.
      throw new ConfigurationError(
        'MCP config URLs must be HTTPS without credentials, query or fragment.',
      );
    }
  }
  if (!endpoints.length)
    throw new ConfigurationError(
      'MCP config has no HTTPS server URLs. Stdio servers are not inspected.',
    );
  return [...new Set(endpoints)];
}

type Query = {
  input: InputTool;
  terms: string[];
  removed: Set<string>;
  why: SkillsReason[];
  count: number;
};
function queryFor(
  input: InputTool,
  answer: StatusGoal['tools'][number],
): Query {
  // Validate every supplied identity, including removed and unknown answers.
  if (
    (answer.status === 'observed' && (!answer.tool || !answer.service)) ||
    (answer.tool && answer.tool.name !== input.tool) ||
    (answer.service &&
      recordIdentity(answer.service.endpoint, input.tool) !==
        recordIdentity(input.endpoint, input.tool))
  )
    throw new InspectionError(
      'The record returned a different endpoint or tool.',
    );
  if (
    answer.status === 'observed' &&
    (!Array.isArray(answer.tool?.inputs) ||
      answer.tool.inputs.some((value) => typeof value !== 'string'))
  )
    throw new InspectionError(
      'The record returned an incomplete tool input list.',
    );
  const inputs = strings(answer.tool?.inputs);
  const last = object(answer.change?.last);
  // The current API exposes no input diff. These explicit optional extensions
  // are used only if a future signed answer supplies them; never infer a rename.
  const removed = new Set(strings(last.removedInputs));
  if (Array.isArray(last.renamedInputs))
    for (const rename of last.renamedInputs) {
      const from = object(rename).from;
      if (typeof from === 'string' && from) removed.add(from);
    }
  for (const name of inputs) removed.delete(name);
  const why: SkillsReason[] = [];
  if (answer.changedSinceTime || answer.change?.changedSince)
    why.push('tool_changed_since');
  if (
    last.class === 'breaking' &&
    typeof last.at === 'string' &&
    statusAtOrAfter(last.at, input.sinceTime)
  )
    why.push('breaking_change');
  if (answer.status === 'removed') why.push('tool_removed');
  else if (answer.status !== 'observed') why.push('not_observed');
  if (answer.payment?.requiresPayment) why.push('asks_for_payment');
  return {
    input,
    terms: [...new Set([input.tool, ...inputs, ...removed])],
    removed,
    why,
    count: 0,
  };
}

function recordIdentity(endpoint: string, tool: string): string {
  try {
    return JSON.stringify([new URL(endpoint).href, tool]);
  } catch {
    throw new InspectionError('The record returned an invalid endpoint.');
  }
}

/** Local exact-token matches only. Line contents never enter the report. */
export async function matchSkillMentions(
  root: string,
  checked: InputTool[],
  answers: StatusGoal['tools'],
  options: SkillFileOptions = {},
) {
  if (answers.length !== checked.length)
    throw new InspectionError('Incomplete skills record response.');
  const byIdentity = new Map<string, StatusGoal['tools'][number]>();
  answers.forEach((answer, index) => {
    // Non-observed records can omit identity. Only those fields use the
    // client's aligned checkedInputs; supplied identities never use position.
    const input = checked[index]!;
    const id = recordIdentity(
      answer.service?.endpoint ?? input.endpoint,
      answer.tool?.name ?? input.tool,
    );
    if (byIdentity.has(id))
      throw new InspectionError('The record returned a duplicate tool.');
    byIdentity.set(id, answer);
  });
  const queries = checked.map((input) => {
    const answer = byIdentity.get(recordIdentity(input.endpoint, input.tool));
    if (!answer)
      throw new InspectionError(
        'The record returned a different endpoint or tool.',
      );
    return queryFor(input, answer);
  });
  const limits = { ...DEFAULT_LIKELY_USES_LIMITS, ...options.limits };
  const mentions: SkillMention[] = [];
  let omitted = false;
  type Term = { query: Query; term: string; order: number };
  const identifiers = new Map<string, Term[]>();
  const fallback: Term[] = [];
  let order = 0;
  for (const query of queries)
    for (const term of query.terms) {
      if (!query.why.length && !query.removed.has(term)) continue;
      const entry = { query, term, order: order++ };
      if (/^[A-Za-z0-9_]+$/.test(term)) {
        const entries = identifiers.get(term) ?? [];
        entries.push(entry);
        identifiers.set(term, entries);
      } else if (fallback.length < 128) fallback.push(entry);
      else omitted = true;
    }
  const scan = await scanSkillFiles(root, options, (path, content) => {
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      // Index lookups replace lines × tools × inputs scans. Keep one location
      // per term per line, in the existing tool/term order, including short IDs.
      const line = lines[index]!;
      const found = new Set<Term>();
      for (const token of line.matchAll(/[A-Za-z0-9_]+/g))
        for (const entry of identifiers.get(token[0]) ?? []) found.add(entry);
      for (const entry of fallback)
        if (matchesWholeIdentifier(line, entry.term)) found.add(entry);
      for (const { query, term } of [...found].sort(
        (a, b) => a.order - b.order,
      )) {
        if (query.count >= limits.maxPerChange) {
          omitted = true;
          continue;
        }
        if (mentions.length >= limits.maxTotal) return false;
        const why = [...query.why];
        if (query.removed.has(term)) why.push('input_not_recorded');
        mentions.push({
          path,
          line: index + 1,
          term,
          tool: query.input.tool,
          endpoint: query.input.endpoint,
          why,
        });
        query.count++;
      }
    }
  });
  return {
    mentions,
    truncated: scan.truncated || omitted,
    filesRead: scan.filesRead,
    bytesRead: scan.bytesRead,
  };
}

export function formatSkills(report: SkillsReport): string {
  const rows = report.mentions.map((item) =>
    [
      `${item.path}:${item.line}`,
      item.term,
      item.tool,
      item.endpoint,
      item.why.join(', '),
    ]
      .map((value) => sanitizeTerminal(value))
      .join(' | '),
  );
  return (
    [
      'Location | Term | Tool | Endpoint | Why',
      ...rows,
      `${report.mentions.length} stale mentions; ${report.checked.length} tools checked; ${report.filesRead} files read.${report.truncated ? ' Truncated: some locations may be missing.' : ''}`,
      'No recorded change is not proof of no change. Input mentions are exact matches; they do not prove a call or which tool uses that input.',
    ].join('\n') + '\n'
  );
}

/** URI-encode each path component so #, %, spaces and controls remain literal. */
export function skillsToSarif(report: SkillsReport) {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        automationDetails: { id: 'interfacedelta-skills/' },
        tool: {
          driver: {
            name: 'InterfaceDelta skills',
            version: CLI_VERSION,
            rules: SKILLS_REASONS.map((id) => ({
              id,
              shortDescription: { text: id },
            })),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: report.truncated
              ? [
                  {
                    level: 'warning',
                    message: {
                      text: 'Skills scan truncated; some locations may be missing.',
                    },
                  },
                ]
              : [],
          },
        ],
        results: report.mentions.flatMap((item) =>
          item.why.map((ruleId) => ({
            ruleId,
            level: 'warning',
            message: {
              text: sanitizeTerminal(
                `${item.term}: ${ruleId} (${item.tool} at ${item.endpoint})`,
              ),
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: item.path.split('/').map(encodeURIComponent).join('/'),
                  },
                  region: { startLine: item.line },
                },
              },
            ],
          })),
        ),
      },
    ],
  };
}

export type SkillsOptions = {
  dependencies?: string;
  skillsDir?: string;
  skillIncludes?: string[];
  mcpConfig?: string;
  since?: string;
  apiUrl?: string;
  failOn?: string;
  json?: boolean;
  sarif?: string;
};

export async function runSkills(args: SkillsOptions, env: StatusEnvironment) {
  const failOn = skillsFailOn(args.failOn);
  if (args.since !== undefined) statusSince(args.since);
  skillFileMatcher(args.skillIncludes);
  let root: string;
  try {
    root = await validateScanRoot(args.skillsDir ?? '.');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'does not exist'
        : code === 'EACCES' || code === 'EPERM'
          ? 'cannot be accessed (permission denied)'
          : code
            ? `could not be validated (${sanitizeTerminal(code)})`
            : 'must be a directory without symlinks and must not change during validation';
    throw new ConfigurationError(`Skills directory ${reason}.`);
  }
  const tools = await statusInputs(args);
  if (args.mcpConfig) {
    const endpoints = await skillConfigEndpoints(args.mcpConfig);
    const known = new Set(tools.map((tool) => new URL(tool.endpoint).href));
    if (endpoints.some((endpoint) => !known.has(endpoint)))
      throw new ConfigurationError(
        'An MCP config server has no baseline tool inventory. Record its MCP dependency with interfacedelta baseline first; configs contain URLs, not tool names.',
      );
  }
  const unique = new Map<string, InputTool>();
  for (const tool of tools) {
    const id = JSON.stringify([tool.endpoint, tool.tool]);
    const previous = unique.get(id);
    if (!previous || statusAtOrAfter(previous.sinceTime, tool.sinceTime))
      unique.set(id, tool);
  }
  const checked = [...unique.values()];
  const result = await checkStatusTools(checked, { apiUrl: args.apiUrl }, env);
  const report: SkillsReport = {
    formatVersion: 'interfacedelta-skills-v1',
    ...(await matchSkillMentions(
      root,
      result.checkedInputs,
      result.checkedTools,
      {
        include: args.skillIncludes,
      },
    )),
    checked: result.checkedInputs,
    signedAnswers: result.outputs,
  };
  const output = args.json
    ? JSON.stringify(report, null, 2) + '\n'
    : formatSkills(report);
  // Preserve signatures rather than redacting inside signed answers.
  assertNoSecret(output, 'skills output');
  if (args.sarif)
    await writeAtomic(
      args.sarif,
      JSON.stringify(skillsToSarif(report), null, 2) + '\n',
      true,
    );
  return {
    report,
    output,
    exitCode: report.mentions.some((item) =>
      item.why.some((why) => failOn.includes(why)),
    )
      ? 1
      : 0,
  };
}
