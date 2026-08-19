import { canonicalJson } from '@interfacedelta/core';
import { parseArguments, HELP } from './arguments';
import { checkBaseline, createBaseline, inspectForDistribution, type Inspector } from './core';
import { exitCodeFor } from './errors';
import { formatCheck, formatInspection, machineJson } from './format';
import { readJsonFile, writeAtomic } from './io';
import { sanitizeTerminal } from './sanitize';
import { CLI_VERSION } from './types';

export type RunDependencies = {
  inspector?: Inspector;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  now?: () => Date;
};

export async function runCli(
  argv: string[],
  dependencies: RunDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(value));
  try {
    const args = parseArguments(argv);
    if (args.command === 'help') {
      stdout(`${HELP}\n`);
      return 0;
    }
    if (args.command === 'version') {
      stdout(`${CLI_VERSION}\n`);
      return 0;
    }
    const url = args.url!;
    if (args.command === 'inspect') {
      const result = await inspectForDistribution(
        url,
        args.mcpEndpoint,
        dependencies.inspector,
      );
      const output = args.json
        ? machineJson(result)
        : `${formatInspection(result.passport)}\n`;
      if (args.output) await writeAtomic(args.output, args.json ? output : `${canonicalJson(result)}\n`);
      else stdout(output);
      return 0;
    }
    if (args.command === 'baseline') {
      const baseline = await createBaseline(
        url,
        args.mcpEndpoint,
        dependencies.inspector,
        dependencies.now,
      );
      await writeAtomic(args.output!, `${canonicalJson(baseline)}\n`, args.force);
      stdout(`Baseline written to ${sanitizeTerminal(args.output!)}. Review publisher-provided metadata before committing it.\n`);
      return 0;
    }
    const baseline = await readJsonFile(args.baseline!);
    const result = await checkBaseline(url, baseline, {
      mcpEndpoint: args.mcpEndpoint,
      failOn: args.failOn,
      inspector: dependencies.inspector,
    });
    stdout(args.json ? machineJson(result) : `${formatCheck(result)}\n`);
    return result.policy.result === 'failed' ? 1 : 0;
  } catch (error) {
    stderr(`InterfaceDelta error: ${sanitizeTerminal(error instanceof Error ? error.message : 'Unknown failure.')}\n`);
    return exitCodeFor(error);
  }
}
