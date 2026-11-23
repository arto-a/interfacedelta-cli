import { AGENT_CHECK_FAIL_ON } from './agent-check';
import { DEFAULT_DEPENDENCIES_PATH } from './dependencies';
import { ConfigurationError } from './errors';
import { CLI_VERSION } from './types';
import { parseCitationArguments } from './citation-arguments';

export type ParsedArguments = {
  command:
    | 'cite'
    | 'citations'
    | 'skills'
    | 'status'
    | 'agent-check'
    | 'inspect'
    | 'baseline'
    | 'check'
    | 'accept'
    | 'watch'
    | 'policy'
    | 'version'
    | 'help';
  skillsDir?: string;
  citationTool?: string;
  citationFileSource?: string;
  citationUrl?: string;
  citationGit?: string;
  citationFetch?: boolean;
  citationFile?: string;
  citationKeys?: string;
  skillIncludes?: string[];
  mcpConfig?: string;
  since?: string;
  apiUrl?: string;
  /** agent-check: a config file or directory; '' defaults to the current directory. */
  agentPath?: string;
  /** agent-check: force exactly one config file. */
  agentConfig?: string;
  /** agent-check: also read the user's Claude Desktop, Cursor and VS Code configs. */
  includeUserConfigs?: boolean;
  format?: 'github' | 'generic';
  include?: 'all' | 'passing';
  noCheck?: boolean;
  url?: string;
  mcpEndpoint?: string;
  baseline?: string;
  /** Set when the command runs over a dependencies file instead of one URL. */
  dependencies?: string;
  output?: string;
  failOn?: string;
  onError?: string;
  sarif?: string;
  /** `<https-origin>=INTERFACEDELTA_TOKEN_<NAME>` bindings, repeatable. */
  tokens: string[];
  /** baseline: write only these dependencies (repeatable). */
  only: string[];
  /** accept: the dependency and change positionals, and their record. */
  acceptDependency?: string;
  change?: string;
  reason?: string;
  days?: string;
  expires?: string;
  by?: string;
  /** watch: where to sync, when not taken from GitHub Actions or the clone. */
  repository?: string;
  ref?: string;
  /** check: search this directory for likely uses of changed names; '' means the current directory. */
  findUses?: string;
  /** watch: stop watching instead of syncing. */
  off: boolean;
  json: boolean;
  force: boolean;
};

const VALUE_OPTIONS = [
  '--mcp-endpoint',
  '--baseline',
  '--dependencies',
  '--output',
  '--fail-on',
  '--on-error',
  '--sarif',
  '--reason',
  '--days',
  '--expires',
  '--by',
  '--repository',
  '--ref',
] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];
const FIELD: Record<ValueOption, keyof ParsedArguments> = {
  '--mcp-endpoint': 'mcpEndpoint',
  '--baseline': 'baseline',
  '--dependencies': 'dependencies',
  '--output': 'output',
  '--fail-on': 'failOn',
  '--on-error': 'onError',
  '--sarif': 'sarif',
  '--reason': 'reason',
  '--days': 'days',
  '--expires': 'expires',
  '--by': 'by',
  '--repository': 'repository',
  '--ref': 'ref',
};

export function parseArguments(argv: string[]): ParsedArguments {
  const first = argv[0];
  // Help and version win wherever they appear: `check --help` is a question.
  if (!first || argv.some((item) => item === '--help' || item === '-h'))
    return {
      command: 'help',
      json: false,
      force: false,
      off: false,
      tokens: [],
      only: [],
    };
  if (argv.includes('--version'))
    return {
      command: 'version',
      json: false,
      force: false,
      off: false,
      tokens: [],
      only: [],
    };
  if (first === 'cite' || first === 'citations')
    return parseCitationArguments(argv);
  if (first === 'skills') {
    const result: ParsedArguments = {
      command: 'skills',
      dependencies: DEFAULT_DEPENDENCIES_PATH,
      json: false,
      force: false,
      off: false,
      tokens: [],
      only: [],
      skillIncludes: [],
    };
    const fields = {
      '--dependencies': 'dependencies',
      '--since': 'since',
      '--fail-on': 'failOn',
      '--api-url': 'apiUrl',
      '--mcp-config': 'mcpConfig',
      '--sarif': 'sarif',
    } as const;
    for (let index = 1; index < argv.length; index++) {
      const option = argv[index]!;
      if (option === '--json') {
        result.json = true;
        continue;
      }
      if (!option.startsWith('-')) {
        if (result.skillsDir !== undefined)
          throw new ConfigurationError('skills accepts at most one directory.');
        result.skillsDir = option;
        continue;
      }
      if (option !== '--include' && !Object.hasOwn(fields, option))
        throw new ConfigurationError(`Unknown skills option: ${option}`);
      const value = argv[++index];
      if (!value || value.startsWith('-'))
        throw new ConfigurationError(`${option} requires a value.`);
      if (option === '--include') result.skillIncludes!.push(value);
      else result[fields[option as keyof typeof fields]] = value;
    }
    return result;
  }
  if (first === 'status') {
    const result: ParsedArguments = {
      command: 'status',
      dependencies: DEFAULT_DEPENDENCIES_PATH,
      json: false,
      force: false,
      off: false,
      tokens: [],
      only: [],
    };
    const fields = {
      '--dependencies': 'dependencies',
      '--since': 'since',
      '--fail-on': 'failOn',
      '--api-url': 'apiUrl',
    } as const;
    for (let index = 1; index < argv.length; index++) {
      const option = argv[index]!;
      if (option === '--json') {
        result.json = true;
        continue;
      }
      if (!Object.hasOwn(fields, option))
        throw new ConfigurationError(`Unknown status option: ${option}`);
      const value = argv[++index];
      if (!value || value.startsWith('-'))
        throw new ConfigurationError(`${option} requires a value.`);
      result[fields[option as keyof typeof fields]] = value;
    }
    if (result.failOn && !['changed', 'breaking'].includes(result.failOn))
      throw new ConfigurationError('--fail-on must be changed or breaking.');
    return result;
  }
  if (first === 'agent-check') {
    const result: ParsedArguments = {
      command: 'agent-check',
      json: false,
      force: false,
      off: false,
      tokens: [],
      only: [],
      agentPath: '.',
    };
    const fields = {
      '--config': 'agentConfig',
      '--since': 'since',
      '--fail-on': 'failOn',
      '--api-url': 'apiUrl',
      '--sarif': 'sarif',
    } as const;
    const positionals: string[] = [];
    for (let index = 1; index < argv.length; index++) {
      const option = argv[index]!;
      if (option === '--json') {
        result.json = true;
        continue;
      }
      if (option === '--include-user-configs') {
        result.includeUserConfigs = true;
        continue;
      }
      if (!Object.hasOwn(fields, option)) {
        if (option.startsWith('-'))
          throw new ConfigurationError(`Unknown agent-check option: ${option}`);
        positionals.push(option);
        continue;
      }
      const value = argv[++index];
      if (!value || value.startsWith('-'))
        throw new ConfigurationError(`${option} requires a value.`);
      (result as Record<string, unknown>)[
        fields[option as keyof typeof fields]
      ] = value;
    }
    if (positionals.length > 1)
      throw new ConfigurationError('agent-check accepts at most one path.');
    if (positionals.length && result.agentConfig)
      throw new ConfigurationError('Give either a path or --config, not both.');
    if (positionals.length) result.agentPath = positionals[0];
    if (result.failOn !== undefined) {
      const tokens = result.failOn
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
      if (
        !tokens.length ||
        tokens.some(
          (token) =>
            !(AGENT_CHECK_FAIL_ON as readonly string[]).includes(token),
        )
      )
        throw new ConfigurationError(
          `--fail-on must be a comma-separated list of ${AGENT_CHECK_FAIL_ON.join(', ')}.`,
        );
      result.failOn = [...new Set(tokens)].join(',');
    }
    return result;
  }
  if (first === 'policy') {
    if (argv[1] !== 'export')
      throw new ConfigurationError('Expected policy export.');
    const result: ParsedArguments = {
      command: 'policy',
      json: false,
      force: false,
      off: false,
      tokens: [],
      only: [],
      dependencies: DEFAULT_DEPENDENCIES_PATH,
      include: 'passing',
    };
    const fields = {
      '--format': 'format',
      '--include': 'include',
      '--out': 'output',
      '--dependencies': 'dependencies',
      '--fail-on': 'failOn',
      '--on-error': 'onError',
    } as const;
    for (let index = 2; index < argv.length; index++) {
      const option = argv[index]!;
      if (option === '--no-check') {
        result.noCheck = true;
        continue;
      }
      if (!Object.hasOwn(fields, option) && option !== '--token')
        throw new ConfigurationError(`Unknown policy export option: ${option}`);
      const value = argv[++index];
      if (!value || value.startsWith('-'))
        throw new ConfigurationError(`${option} requires a value.`);
      if (option === '--token') result.tokens.push(value);
      else
        (result as Record<string, unknown>)[
          fields[option as keyof typeof fields]
        ] = value;
    }
    if (result.format !== 'github' && result.format !== 'generic')
      throw new ConfigurationError('--format must be github or generic.');
    if (result.include !== 'all' && result.include !== 'passing')
      throw new ConfigurationError('--include must be all or passing.');
    if (
      result.noCheck &&
      (result.tokens.length || result.failOn || result.onError)
    )
      throw new ConfigurationError(
        '--no-check cannot be combined with check options.',
      );
    return result;
  }
  if (
    !['inspect', 'baseline', 'check', 'accept', 'watch', 'version'].includes(
      first,
    )
  )
    throw new ConfigurationError(`Unknown command: ${first}`);
  const command = first as ParsedArguments['command'];
  if (command === 'version') {
    if (argv.length !== 1)
      throw new ConfigurationError('version does not accept arguments.');
    return {
      command,
      json: false,
      force: false,
      off: false,
      tokens: [],
      only: [],
    };
  }
  const result: ParsedArguments = {
    command,
    json: false,
    force: false,
    off: false,
    tokens: [],
    only: [],
  };
  const positionals: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith('-')) {
      positionals.push(value);
      continue;
    }
    if (value === '--json') result.json = true;
    else if (value === '--force') result.force = true;
    else if (value === '--off') result.off = true;
    else if (value === '--find-uses') {
      // An optional value: anything that is not another option is the directory.
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        result.findUses = next;
        index++;
      } else result.findUses = '';
    } else if (value === '--token' || value === '--only') {
      const next = argv[++index];
      if (!next || next.startsWith('-'))
        throw new ConfigurationError(`${value} requires a value.`);
      (value === '--token' ? result.tokens : result.only).push(next);
    } else if ((VALUE_OPTIONS as readonly string[]).includes(value)) {
      const next = argv[++index];
      if (!next || next.startsWith('-'))
        throw new ConfigurationError(`${value} requires a value.`);
      (result as Record<string, unknown>)[FIELD[value as ValueOption]] = next;
    } else throw new ConfigurationError(`Unknown option: ${value}`);
  }
  if (command === 'accept') {
    for (const [present, flag] of [
      [result.only.length > 0, '--only'],
      [result.tokens.length > 0, '--token'],
      [result.json, '--json'],
      [result.force, '--force'],
      [result.failOn, '--fail-on'],
      [result.onError, '--on-error'],
      [result.sarif, '--sarif'],
      [result.baseline, '--baseline'],
      [result.output, '--output'],
      [result.mcpEndpoint, '--mcp-endpoint'],
      [result.repository, '--repository'],
      [result.ref, '--ref'],
      [result.off, '--off'],
      [result.findUses !== undefined, '--find-uses'],
    ] as const)
      if (present)
        throw new ConfigurationError(`${flag} is not valid with accept.`);
    if (positionals.length !== 2)
      throw new ConfigurationError(
        'accept takes a dependency name and a change id.',
      );
    [result.acceptDependency, result.change] = positionals;
    result.dependencies ??= DEFAULT_DEPENDENCIES_PATH;
    if (!result.reason)
      throw new ConfigurationError('accept requires --reason.');
    if (Boolean(result.days) === Boolean(result.expires))
      throw new ConfigurationError(
        'accept requires exactly one of --days or --expires.',
      );
    return result;
  }
  if (command === 'watch') {
    for (const [present, flag] of [
      [result.only.length > 0, '--only'],
      [result.tokens.length > 0, '--token'],
      [result.failOn, '--fail-on'],
      [result.onError, '--on-error'],
      [result.sarif, '--sarif'],
      [result.baseline, '--baseline'],
      [result.output, '--output'],
      [result.mcpEndpoint, '--mcp-endpoint'],
      [result.reason, '--reason'],
      [result.days, '--days'],
      [result.expires, '--expires'],
      [result.by, '--by'],
      [result.findUses !== undefined, '--find-uses'],
    ] as const)
      if (present)
        throw new ConfigurationError(`${flag} is not valid with watch.`);
    if (positionals.length)
      throw new ConfigurationError(
        'watch takes no target URL: it syncs the dependencies file.',
      );
    if (result.off && result.force)
      throw new ConfigurationError('--force is not valid with --off.');
    result.dependencies ??= DEFAULT_DEPENDENCIES_PATH;
    return result;
  }
  for (const [option, flag] of [
    ['repository', '--repository'],
    ['ref', '--ref'],
  ] as const)
    if (result[option])
      throw new ConfigurationError(`${flag} is only valid with watch.`);
  if (result.off)
    throw new ConfigurationError('--off is only valid with watch.');
  for (const [option, flag] of [
    ['reason', '--reason'],
    ['days', '--days'],
    ['expires', '--expires'],
    ['by', '--by'],
  ] as const)
    if (result[option])
      throw new ConfigurationError(`${flag} is only valid with accept.`);
  if (result.only.length && command !== 'baseline')
    throw new ConfigurationError('--only is only valid with baseline.');
  if (positionals.length > 1)
    throw new ConfigurationError(`${command} accepts at most one target URL.`);
  result.url = positionals[0];
  const onlyFor = (
    option: keyof ParsedArguments,
    flag: string,
    commands: ParsedArguments['command'][],
    presentWhenEmpty = false,
  ) => {
    const present = presentWhenEmpty
      ? result[option] !== undefined
      : Boolean(result[option]);
    if (present && !commands.includes(command))
      throw new ConfigurationError(
        `${flag} is only valid with ${commands.join(' or ')}.`,
      );
  };
  onlyFor('failOn', '--fail-on', ['check']);
  onlyFor('onError', '--on-error', ['check']);
  onlyFor('sarif', '--sarif', ['check']);
  onlyFor('baseline', '--baseline', ['check']);
  onlyFor('findUses', '--find-uses', ['check'], true);
  onlyFor('force', '--force', ['baseline']);
  onlyFor('dependencies', '--dependencies', ['baseline', 'check']);
  if (command === 'inspect') {
    if (!result.url)
      throw new ConfigurationError('inspect requires exactly one target URL.');
    return result;
  }
  if (result.url && result.dependencies)
    throw new ConfigurationError(
      'Give either one target URL or --dependencies, not both.',
    );
  if (result.url && result.only.length)
    throw new ConfigurationError('--only applies to a dependencies file.');
  if (!result.url) {
    if (result.mcpEndpoint || result.baseline || result.output)
      throw new ConfigurationError(
        `${command} over a dependencies file does not take --mcp-endpoint, --baseline or --output.`,
      );
    result.dependencies ??= DEFAULT_DEPENDENCIES_PATH;
    if (command === 'baseline' && result.json)
      throw new ConfigurationError('--json is not valid with baseline.');
    return result;
  }
  if (command === 'baseline' && !result.output)
    throw new ConfigurationError('baseline requires --output.');
  if (command === 'baseline' && result.json)
    throw new ConfigurationError('--json is not valid with baseline.');
  if (command === 'check' && !result.baseline)
    throw new ConfigurationError('check requires --baseline.');
  return result;
}

export const HELP = `InterfaceDelta CLI ${CLI_VERSION}

Usage:
  interfacedelta inspect <https-url> [--mcp-endpoint <https-url>] [--token <binding>] [--json] [--output <file>]
  interfacedelta baseline <https-url> --output <file> [--mcp-endpoint <https-url>] [--token <binding>] [--force]
  interfacedelta baseline [--dependencies <file>] [--only <name>] [--token <binding>] [--force]
  interfacedelta check <https-url> --baseline <file> [--mcp-endpoint <https-url>] [options]
  interfacedelta check [--dependencies <file>] [options]
  interfacedelta accept <dependency> <change-id> --reason <text> (--days <n> | --expires <YYYY-MM-DD>) [--by <who>] [--dependencies <file>]
  interfacedelta watch [--dependencies <file>] [--repository <owner/name>] [--ref <branch>] [--force] [--json]
  interfacedelta watch --off [--repository <owner/name>] [--ref <branch>]
  interfacedelta policy export --format github|generic [--include all|passing] [--out <file>] [--no-check]
  interfacedelta status [--dependencies <path>] [--since <RFC3339>] [--json] [--fail-on changed|breaking] [--api-url <url>]
  interfacedelta agent-check [path] [--config <file>] [--include-user-configs] [--since <RFC3339>] [--fail-on <list>] [--json] [--sarif <file>] [--api-url <url>]

  interfacedelta skills [dir] [--dependencies <file>] [--mcp-config <file>] [--include <glob>] [--since <RFC3339>] [--json] [--sarif <file>] [--fail-on <list>] [--api-url <url>]
  interfacedelta cite <endpoint> <tool> [--file <skill-file>] [--api-url <url>]
  interfacedelta cite (--file-source <path> | --url <https-uri> | --git <https-repo>@<commit>[:path]) [--file <skill-file>]
  interfacedelta citations [dir] [--include <glob>] [--keys <file>] [--json] [--sarif <file>] [--fail-on <list>] [--fetch] [--api-url <url>]
  interfacedelta version

Status (stored record only; no dependency scan):
  Reads the dependencies file and its baselines; start time defaults to each
  baseline's creation time. --since supplies a shared RFC 3339 start time.
  INTERFACEDELTA_AGENT_KEY uses REST, at most 50 tools per batch. Without a key,
  one all-or-nothing public MCP goal covers up to 5 tools with one start time.
  --api-url defaults to https://interfacedelta.com (HTTPS; localhost HTTP for tests).
  --json preserves each signed goal response; multiple batches are separate JSON
  values. Keyless output is the MCP tool result JSON (including quota).
  Verify the signed goal at /api/v1/record/check/verify (keyless: its result field).
  --fail-on changed|breaking uses the returned summary counts; absent means report only.
  Exit codes: 0 no threshold match; 1 threshold matched; 2 usage/configuration;
  3 record unavailable (network, rate limit or server failure).
  No recorded change is not proof of no change.

Agent definitions and skills:
  agent-check reads configured tools; skills finds exact stale mentions;
  citations checks pinned sources; cite creates the source pins.
  Each command reports by default and has its own --fail-on and SARIF output.

Agent-check (reads MCP client configs; stored record only):
  Reads the agent's MCP config and reports, per configured tool, what the
  InterfaceDelta record says: changed, breaking since start, stale, not
  observed, asks for payment, moves money, deletes, sends messages. No
  verdicts or scores; no calls to the configured servers.
  path is a config file or a directory searched for .mcp.json,
  .cursor/mcp.json, .vscode/mcp.json and .vscode/settings.json (default: the
  current directory). --config forces one file. User-home configs (Claude
  Desktop, Cursor, VS Code) are read only with --include-user-configs.
  Config formats are detected by content: mcpServers, servers or mcp.servers.
  Env values, headers, args and tokens in the config are never printed, logged
  or sent. Credential-bearing URL components are omitted from reports; signed
  answers echoing a credential are refused. HTTP endpoints are not_checkable;
  HTTPS servers are checked; stdio servers are listed as
  not_checkable_local with the command name only.
  Tool names come from the record's get_atlas_entry full view (one lookup per
  origin), then go to check_tools exactly as status. Without a key, the first
  five tools are checked in one public MCP goal and the rest are listed as
  not checked; set INTERFACEDELTA_AGENT_KEY for REST batches of 50.
  Without --since, the start time is the earliest first retained observation
  among the checked servers ("since first observed", as far as the record's
  bounded history goes).
  The default human output is a table.
  --json prints interfacedelta-agent-check-v1 with every signed goal embedded
  complete. --sarif writes SARIF 2.1.0 for code scanning.
  --fail-on takes breaking, changed, stale, payment, money, not_observed.
  Exit codes: 0 no condition matched; 1 a condition matched; 2 usage/config
  (malformed or missing config); 3 record unavailable.

Skills (stored record plus local instruction files):
  Find stale exact tool/input mentions in SKILL.md, AGENTS.md, CLAUDE.md,
  GEMINI.md, Cursor rules, Copilot instructions, Claude skills and prompts/**/*.md.
  --include <glob> adds root-relative files (*, **, ?), repeatable.
  Never prints line text. Default directory: .; dependencies path is relative to cwd.
  --mcp-config reads server URLs only; baseline inventories supply tool names.
  --since defaults to baseline creation time. Same signed client/limits as status.
  --json: interfacedelta-skills-v1, including exact signed response strings.
  --sarif <file>: also write SARIF with file and line locations.
  --fail-on <list>: tool_changed_since, breaking_change, tool_removed,
    input_not_recorded, asks_for_payment, not_observed (default: report only).
  Exit codes: 0 no threshold match; 1 threshold matched; 2 usage/configuration;
  3 record unavailable. An unchanged record is not proof instructions are current.

Citations:
  cite verifies and stores a signed answer plus published public keys, prints an
  invisible Markdown comment, and optionally inserts/updates it at the file top.
  Storage is beside --file (default cwd); existing instruction text is preserved.
  citations reuses the skills finder. Answer paths are relative to each skill file.
  Stored signatures verify offline with adjacent keys.json or --keys (scan-root-relative).
  Current fingerprints come from the same stored-record client/limits as status.
  --json: interfacedelta-citations-v1; --sarif writes root-relative file locations.
  Experimental file/url/git source kinds: file hashes check offline; --fetch opts
  into URL GETs (HTTPS, 3 redirects, 10 MiB, 15 s, concurrency 4). cite --url fetches once.
  Git pins are syntax-only, including with --fetch. File paths are checkout-relative.
  Default: report only. --fail-on accepts changed, removed, malformed, signature_invalid,
  missing, unreachable, not_checked.
  Exit codes: 0 no threshold match; 1 threshold matched; 2 usage/configuration;
  3 record/keys unavailable or invalid current answer. Never prints line text.

Check options:
  --fail-on <list>     breaking (default), non_breaking, indeterminate, informational, metadata
  --on-error <mode>    fail (default) or warn: whether an inspection failure fails the run
  --json               machine-readable result on stdout
  --sarif <file>       also write SARIF 2.1.0 for code scanning
  --find-uses [dir]    also search a directory (default: the current one) for
                       likely uses of changed tool, prompt and resource names;
                       file and line hints in the output, informational only

Policy export:
  Uses the dependencies file and the same live checks and exit codes as check.
  --dependencies, --fail-on, --on-error and --token are also supported.
  --no-check           no network or baselines; unchecked entries need review
  GitHub output wraps managedSettings (copy only that object to GitHub) and excluded.

Sign-in (inspect, baseline, check and policy export):
  --token <origin>=INTERFACEDELTA_TOKEN_<NAME>
                       send the token in that environment variable, as a bearer
                       token, to explicit MCP endpoints on that HTTPS origin only.
                       Repeatable. Repository files cannot add tokens.

Watch (Pro and Team):
  hands the dependencies file to InterfaceDelta, which checks every dependency
  continuously and delivers each decision to its owner. Needs
  INTERFACEDELTA_API_TOKEN set to a watch token from Routing → Watch tokens
  with the lockfiles:write scope for this repository and branch. A run on an older
  commit than the watched one is skipped unless --force.

Without a URL, baseline, check and watch use ${DEFAULT_DEPENDENCIES_PATH}.
Public HTTPS targets only. No credentials unless you bind one with --token; no active tool calls or telemetry.`;
