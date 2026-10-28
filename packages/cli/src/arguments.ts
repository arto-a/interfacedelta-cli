import { DEFAULT_DEPENDENCIES_PATH } from './dependencies';
import { ConfigurationError } from './errors';
import { CLI_VERSION } from './types';

export type ParsedArguments = {
  command:
    'inspect' | 'baseline' | 'check' | 'accept' | 'watch' | 'version' | 'help';
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
    else if (value === '--token' || value === '--only') {
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
  ) => {
    if (result[option] && !commands.includes(command))
      throw new ConfigurationError(
        `${flag} is only valid with ${commands.join(' or ')}.`,
      );
  };
  onlyFor('failOn', '--fail-on', ['check']);
  onlyFor('onError', '--on-error', ['check']);
  onlyFor('sarif', '--sarif', ['check']);
  onlyFor('baseline', '--baseline', ['check']);
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
  interfacedelta version

Check options:
  --fail-on <list>     breaking (default), non_breaking, indeterminate, informational, metadata
  --on-error <mode>    fail (default) or warn: whether an inspection failure fails the run
  --json               machine-readable result on stdout
  --sarif <file>       also write SARIF 2.1.0 for code scanning

Sign-in (inspect, baseline and check):
  --token <origin>=INTERFACEDELTA_TOKEN_<NAME>
                       send the token in that environment variable, as a bearer
                       token, to explicit MCP endpoints on that HTTPS origin only.
                       Repeatable. Repository files cannot add tokens.

Watch (Pro and Team):
  hands the dependencies file to InterfaceDelta, which checks every dependency
  continuously and delivers each decision to its owner. Needs
  INTERFACEDELTA_API_TOKEN with the lockfiles:write scope. A run on an older
  commit than the watched one is skipped unless --force.

Without a URL, baseline, check and watch use ${DEFAULT_DEPENDENCIES_PATH}.
Public HTTPS targets only. No credentials unless you bind one with --token; no active tool calls or telemetry.`;
