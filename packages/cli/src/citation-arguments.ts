import type { ParsedArguments } from './arguments';
import { ConfigurationError } from './errors';

export function parseCitationArguments(argv: string[]): ParsedArguments {
  const command = argv[0] as 'cite' | 'citations';
  const result: ParsedArguments = {
    command,
    json: false,
    force: false,
    off: false,
    tokens: [],
    only: [],
    skillIncludes: [],
  };
  const positionals: string[] = [];
  const fields =
    command === 'cite'
      ? ({
          '--file': 'citationFile',
          '--api-url': 'apiUrl',
          '--file-source': 'citationFileSource',
          '--url': 'citationUrl',
          '--git': 'citationGit',
        } as const)
      : ({
          '--fail-on': 'failOn',
          '--sarif': 'sarif',
          '--keys': 'citationKeys',
          '--api-url': 'apiUrl',
        } as const);
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index]!;
    if (
      command === 'citations' &&
      (option === '--json' || option === '--fetch')
    ) {
      if (option === '--json') result.json = true;
      else result.citationFetch = true;
      continue;
    }
    if (!option.startsWith('-')) {
      positionals.push(option);
      continue;
    }
    if (
      !(command === 'citations' && option === '--include') &&
      !Object.hasOwn(fields, option)
    )
      throw new ConfigurationError(`Unknown ${command} option: ${option}`);
    const value = argv[++index];
    if (!value || value.startsWith('-'))
      throw new ConfigurationError(`${option} requires a value.`);
    if (option === '--include') result.skillIncludes!.push(value);
    else
      (result as Record<string, unknown>)[
        fields[option as keyof typeof fields]!
      ] = value;
  }
  if (command === 'cite') {
    const sources = [
      result.citationFileSource,
      result.citationUrl,
      result.citationGit,
    ].filter((value) => value !== undefined);
    if (sources.length > 1 || (sources.length && positionals.length))
      throw new ConfigurationError('Choose exactly one citation source.');
    if (!sources.length && positionals.length !== 2)
      throw new ConfigurationError(
        'cite requires an endpoint and a tool name.',
      );
    [result.url, result.citationTool] = positionals;
  } else {
    if (positionals.length > 1)
      throw new ConfigurationError('citations accepts at most one directory.');
    result.skillsDir = positionals[0];
  }
  return result;
}
