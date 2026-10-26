import { relative } from 'node:path';
import { canonicalJson } from '@interfacedelta/core';
import { parseArguments, HELP } from './arguments';
import {
  checkBaseline,
  createBaseline,
  inspectForDistribution,
  parseFailOn,
  parseOnError,
  assertBindingsUsed,
  credentialFor,
  parseTokenBindings,
  type Inspector,
} from './core';
import {
  baselinePathFor,
  acceptChange,
  checkDependencies,
  downgradable,
  errorKind,
  errorMessage,
  loadDependencies,
  writeDependencyBaselines,
} from './dependencies';
import { ConfigurationError, exitCodeFor } from './errors';
import { redact } from './secrets';
import {
  formatBaselineSet,
  formatCheck,
  formatCheckSet,
  formatInspection,
  machineJson,
} from './format';
import { readJsonFile, writeAtomic } from './io';
import { sanitizeTerminal } from './sanitize';
import { toSarif, type SarifEntry } from './sarif';
import { CHECK_ERROR_FORMAT_VERSION, CLI_VERSION } from './types';

export type RunDependencies = {
  inspector?: Inspector;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  now?: () => Date;
};

/** SARIF anchors results to a repository-relative, slash-separated path. */
const repositoryUri = (path: string) =>
  relative(process.cwd(), path).split('\\').join('/');

export async function runCli(
  argv: string[],
  dependencies: RunDependencies = {},
): Promise<number> {
  const rawStdout =
    dependencies.stdout ?? ((value) => process.stdout.write(value));
  const rawStderr =
    dependencies.stderr ?? ((value) => process.stderr.write(value));
  // No credential value reaches the terminal, whatever a service echoes.
  const stdout = (value: string) => rawStdout(redact(value));
  const stderr = (value: string) => rawStderr(redact(value));
  const fail = (message: string) =>
    stderr(`InterfaceDelta error: ${sanitizeTerminal(message)}\n`);
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
    if (args.command === 'accept') {
      const days = args.days === undefined ? undefined : Number(args.days);
      if (days !== undefined && !(Number.isInteger(days) && days >= 1))
        throw new ConfigurationError('--days must be a whole number of days.');
      const accepted = await acceptChange(
        args.dependencies!,
        {
          dependency: args.acceptDependency!,
          change: args.change!,
          reason: args.reason!,
          expires: days ?? args.expires!,
          ...(args.by ? { by: args.by } : {}),
        },
        (dependencies.now ?? (() => new Date()))(),
      );
      stdout(
        `Accepted ${accepted.change} for ${sanitizeTerminal(accepted.dependency, 64)} until ${accepted.expires}. Commit ${sanitizeTerminal(args.dependencies!)} to apply it.\n`,
      );
      return 0;
    }
    const tokens = parseTokenBindings(args.tokens);
    if (args.url) assertBindingsUsed(tokens, [args.mcpEndpoint]);
    if (args.command === 'inspect') {
      const result = await inspectForDistribution(
        args.url!,
        args.mcpEndpoint,
        dependencies.inspector,
        credentialFor(tokens, args.mcpEndpoint),
      );
      const output = args.json
        ? machineJson(result)
        : `${formatInspection(result.passport)}\n`;
      if (args.output)
        await writeAtomic(
          args.output,
          args.json ? output : `${canonicalJson(result)}\n`,
        );
      else stdout(output);
      return 0;
    }
    if (args.command === 'baseline' && args.dependencies) {
      const outcomes = await writeDependencyBaselines(
        await loadDependencies(args.dependencies),
        {
          force: args.force,
          inspector: dependencies.inspector,
          now: dependencies.now,
          tokens,
          ...(args.only.length ? { only: args.only } : {}),
        },
      );
      stdout(`${formatBaselineSet(outcomes)}\n`);
      const kinds = outcomes.map((item) => item.kind);
      return kinds.includes('configuration') ||
        kinds.includes('credentials') ||
        kinds.includes('skipped')
        ? 2
        : kinds.includes('inspection') || kinds.includes('internal')
          ? 3
          : 0;
    }
    if (args.command === 'baseline') {
      const baseline = await createBaseline(
        args.url!,
        args.mcpEndpoint,
        dependencies.inspector,
        dependencies.now,
        credentialFor(tokens, args.mcpEndpoint),
      );
      await writeAtomic(
        args.output!,
        `${canonicalJson(baseline)}\n`,
        args.force,
      );
      stdout(
        `Baseline written to ${sanitizeTerminal(args.output!)}. Review publisher-provided metadata before committing it.\n`,
      );
      return 0;
    }
    if (args.dependencies) {
      const file = await loadDependencies(
        args.dependencies,
        (dependencies.now ?? (() => new Date()))(),
      );
      const result = await checkDependencies(file, {
        failOn: args.failOn,
        onError: args.onError,
        inspector: dependencies.inspector,
        tokens,
        now: dependencies.now,
      });
      if (args.sarif)
        await writeAtomic(
          args.sarif,
          machineJson(
            toSarif(
              result.dependencies.map((item): SarifEntry => ({
                name: item.name,
                baselineUri: repositoryUri(baselinePathFor(file, item)),
                ...(item.status === 'checked'
                  ? { result: item.result }
                  : { error: item.error.message }),
              })),
            ),
          ),
          true,
        );
      for (const item of result.dependencies)
        if (item.status === 'error')
          stderr(
            `InterfaceDelta ${item.error.kind === 'skipped' || (downgradable(item.error.kind) && result.policy.onError === 'warn') ? 'warning' : 'error'}: ${sanitizeTerminal(item.name, 64)}: ${sanitizeTerminal(item.error.message)}\n`,
          );
      stdout(args.json ? machineJson(result) : `${formatCheckSet(result)}\n`);
      return result.exitCode;
    }
    const onError = parseOnError(args.onError);
    parseFailOn(args.failOn);
    const baseline = await readJsonFile(args.baseline!);
    let result;
    try {
      result = await checkBaseline(args.url!, baseline, {
        mcpEndpoint: args.mcpEndpoint,
        failOn: args.failOn,
        inspector: dependencies.inspector,
        bearerToken: credentialFor(tokens, args.mcpEndpoint),
      });
    } catch (error) {
      const kind = errorKind(error);
      if (kind !== 'skipped' && (!downgradable(kind) || onError === 'fail'))
        throw error;
      stderr(
        `InterfaceDelta warning: ${sanitizeTerminal(errorMessage(error))}${kind === 'skipped' ? '' : ' (on-error: warn)'}\n`,
      );
      if (args.sarif)
        await writeAtomic(
          args.sarif,
          machineJson(
            toSarif([
              {
                baselineUri: repositoryUri(args.baseline!),
                error:
                  error instanceof Error ? error.message : 'Inspection failed.',
              },
            ]),
          ),
          true,
        );
      if (args.json)
        stdout(
          machineJson({
            formatVersion: CHECK_ERROR_FORMAT_VERSION,
            policy: { onError },
            error: { kind: errorKind(error), message: errorMessage(error) },
          }),
        );
      return 0;
    }
    if (args.sarif)
      await writeAtomic(
        args.sarif,
        machineJson(
          toSarif([{ baselineUri: repositoryUri(args.baseline!), result }]),
        ),
        true,
      );
    stdout(args.json ? machineJson(result) : `${formatCheck(result)}\n`);
    return result.policy.result === 'failed' ? 1 : 0;
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Unknown failure.');
    return exitCodeFor(error);
  }
}
