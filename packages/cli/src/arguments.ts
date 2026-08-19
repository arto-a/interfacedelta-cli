import { ConfigurationError } from './errors';

export type ParsedArguments = {
  command: 'inspect' | 'baseline' | 'check' | 'version' | 'help';
  url?: string;
  mcpEndpoint?: string;
  baseline?: string;
  output?: string;
  failOn?: string;
  json: boolean;
  force: boolean;
};

export function parseArguments(argv: string[]): ParsedArguments {
  const first = argv[0];
  if (!first || first === '--help' || first === '-h')
    return { command: 'help', json: false, force: false };
  if (!['inspect', 'baseline', 'check', 'version'].includes(first))
    throw new ConfigurationError(`Unknown command: ${first}`);
  const command = first as ParsedArguments['command'];
  if (command === 'version') {
    if (argv.length !== 1)
      throw new ConfigurationError('version does not accept arguments.');
    return { command, json: false, force: false };
  }
  const result: ParsedArguments = { command, json: false, force: false };
  const positionals: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith('-')) {
      positionals.push(value);
      continue;
    }
    if (value === '--json') result.json = true;
    else if (value === '--force') result.force = true;
    else if (['--mcp-endpoint', '--baseline', '--output', '--fail-on'].includes(value)) {
      const next = argv[++index];
      if (!next || next.startsWith('-'))
        throw new ConfigurationError(`${value} requires a value.`);
      if (value === '--mcp-endpoint') result.mcpEndpoint = next;
      else if (value === '--baseline') result.baseline = next;
      else if (value === '--output') result.output = next;
      else result.failOn = next;
    } else throw new ConfigurationError(`Unknown option: ${value}`);
  }
  if (positionals.length !== 1)
    throw new ConfigurationError(`${command} requires exactly one target URL.`);
  result.url = positionals[0];
  if (command === 'baseline' && !result.output)
    throw new ConfigurationError('baseline requires --output.');
  if (command === 'check' && !result.baseline)
    throw new ConfigurationError('check requires --baseline.');
  if (command !== 'check' && result.failOn)
    throw new ConfigurationError('--fail-on is only valid with check.');
  if (command !== 'baseline' && result.force)
    throw new ConfigurationError('--force is only valid with baseline.');
  return result;
}

export const HELP = `InterfaceDelta CLI 0.1.0

Usage:
  interfacedelta inspect <https-url> [--mcp-endpoint <https-url>] [--json] [--output <file>]
  interfacedelta baseline <https-url> --output <file> [--mcp-endpoint <https-url>] [--force]
  interfacedelta check <https-url> --baseline <file> [--mcp-endpoint <https-url>] [--fail-on breaking,indeterminate] [--json]
  interfacedelta version

Public HTTPS targets only. No credentials, active tool calls, or telemetry.`;
