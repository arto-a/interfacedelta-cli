import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  canonicalJson,
  dependenciesSchema,
  DependenciesDocumentError,
  guardFor,
  MAX_ACCEPTANCE_DAYS,
  MAX_ACCEPTANCES,
  MAX_DEPENDENCIES,
  MAX_RULES,
  parseDependenciesDocument,
  validateDecisions,
  type Acceptance,
  type DependenciesDocument,
} from '@interfacedelta/core';
import {
  checkBaseline,
  createBaseline,
  parseFailOn,
  parseOnError,
  assertBindingsUsed,
  credentialFor,
  type Inspector,
  type TokenBinding,
} from './core';
import {
  ConfigurationError,
  CredentialError,
  CredentialUnavailableError,
  InspectionError,
} from './errors';
import { readJsonFile, writeAtomic } from './io';
import {
  CHECK_SET_FORMAT_VERSION,
  CI_POLICY_VERSION,
  type CheckSetResult,
  type DependencyEntry,
  type DependencyOutcome,
  type ErrorKind,
  type FailSelector,
  type OnError,
} from './types';

export const DEFAULT_DEPENDENCIES_PATH = '.interfacedelta/dependencies.json';
export {
  MAX_ACCEPTANCE_DAYS,
  MAX_ACCEPTANCES,
  MAX_DEPENDENCIES,
  MAX_RULES,
  guardFor,
};
/** Inspections in flight at once: bounded so one run stays polite. */
const CONCURRENCY = 4;

export type DependenciesFile = DependenciesDocument & { path: string };

export async function loadDependencies(
  path = DEFAULT_DEPENDENCIES_PATH,
  now: Date = new Date(),
): Promise<DependenciesFile> {
  const input = await readJsonFile(path, 'Dependencies');
  const directory = dirname(resolve(path));
  try {
    return {
      path,
      ...parseDependenciesDocument(input, now, (baseline) => {
        const resolved = resolve(directory, baseline);
        const inside = relative(directory, resolved);
        if (!inside || inside.startsWith('..') || isAbsolute(inside))
          return `Baseline ${baseline} is outside the dependencies directory.`;
        if (resolved === resolve(path))
          return `Baseline ${baseline} is the dependencies file itself.`;
        return undefined;
      }),
    };
  } catch (error) {
    if (error instanceof DependenciesDocumentError)
      throw new ConfigurationError(error.message);
    throw error;
  }
}

/** Baselines resolve next to the dependencies file, never above it. */
export const baselinePathFor = (
  file: DependenciesFile,
  entry: DependencyEntry,
) => resolve(dirname(resolve(file.path)), entry.baseline);

async function mapBounded<T, R>(
  items: T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

export const errorKind = (error: unknown): ErrorKind =>
  error instanceof ConfigurationError
    ? 'configuration'
    : error instanceof CredentialError
      ? 'credentials'
      : error instanceof CredentialUnavailableError
        ? 'skipped'
        : error instanceof InspectionError
          ? 'inspection'
          : 'internal';
/** Error kinds that on-error: warn reports without failing the run. */
export const downgradable = (kind: ErrorKind) => kind === 'inspection';
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unknown failure.';

export async function checkDependencies(
  file: DependenciesFile,
  options: {
    failOn?: string;
    onError?: string;
    inspector?: Inspector;
    /** Invocation token bindings; the dependencies file cannot add any. */
    tokens?: readonly TokenBinding[];
    now?: () => Date;
  } = {},
): Promise<CheckSetResult> {
  const failOn = parseFailOn(options.failOn ?? file.failOn);
  const onError = parseOnError(options.onError ?? file.onError);
  assertBindingsUsed(
    options.tokens ?? [],
    file.dependencies.map((entry) => entry.mcpEndpoint),
  );
  const dependencies = await mapBounded(
    file.dependencies,
    async (entry): Promise<DependencyOutcome> => {
      try {
        const bearerToken = credentialFor(
          options.tokens ?? [],
          entry.mcpEndpoint,
        );
        const baseline = await readJsonFile(
          baselinePathFor(file, entry),
          'Baseline',
        );
        const result = await checkBaseline(entry.url, baseline, {
          mcpEndpoint: entry.mcpEndpoint ?? undefined,
          failOn: failOn.join(','),
          inspector: options.inspector,
          bearerToken,
          guard: guardFor(file, entry, options.now),
        });
        return { ...entry, status: 'checked', result };
      } catch (error) {
        return {
          ...entry,
          status: 'error',
          error: { kind: errorKind(error), message: errorMessage(error) },
        };
      }
    },
  );
  return summarizeOutcomes(dependencies, failOn, onError);
}

/** Totals and the run's exit code; shared by the CLI and the Action. */
export function summarizeOutcomes(
  dependencies: DependencyOutcome[],
  failOn: FailSelector[],
  onError: OnError,
): CheckSetResult {
  const counts = {
    breaking: 0,
    nonBreaking: 0,
    informational: 0,
    indeterminate: 0,
    dependencies: dependencies.length,
    failed: 0,
    errored: 0,
    skipped: 0,
    blocked: 0,
    warned: 0,
    accepted: 0,
  };
  for (const item of dependencies) {
    if (item.status === 'error') {
      if (item.error.kind === 'skipped') counts.skipped++;
      else counts.errored++;
      continue;
    }
    if (item.result.policy.result === 'failed') counts.failed++;
    for (const decision of item.result.decisions)
      if (decision.source === 'acceptance') counts.accepted++;
      else if (decision.action === 'block') counts.blocked++;
      else if (decision.action === 'warn') counts.warned++;
    for (const key of [
      'breaking',
      'nonBreaking',
      'informational',
      'indeterminate',
    ] as const)
      counts[key] += item.result.comparison.counts[key];
  }
  const errors = dependencies.flatMap((item) =>
    item.status === 'error' ? [item.error.kind] : [],
  );
  // Configuration and credential errors always fail: a missing baseline or a
  // refused token is never transient. Only an unreachable target is what
  // on-error: warn downgrades; a fork pull request's skipped targets never fail.
  const exitCode =
    errors.includes('configuration') || errors.includes('credentials')
      ? 2
      : errors.includes('internal') ||
          (errors.includes('inspection') && onError === 'fail')
        ? 3
        : counts.failed
          ? 1
          : 0;
  return {
    formatVersion: CHECK_SET_FORMAT_VERSION,
    policy: { version: CI_POLICY_VERSION, failOn, onError },
    result: exitCode === 0 ? 'passed' : exitCode === 1 ? 'failed' : 'error',
    exitCode,
    counts,
    dependencies,
  };
}

export type BaselineSetOutcome = DependencyEntry & {
  status: 'written' | 'kept' | 'error';
  kind?: ErrorKind;
  message?: string;
};

/** Writes missing baselines; `force` replaces existing ones too. */
export async function writeDependencyBaselines(
  file: DependenciesFile,
  options: {
    force?: boolean;
    inspector?: Inspector;
    now?: () => Date;
    tokens?: readonly TokenBinding[];
    /** Write only these dependencies. */
    only?: readonly string[];
  } = {},
): Promise<BaselineSetOutcome[]> {
  const only = options.only?.map((name) => name.toLowerCase());
  for (const name of only ?? [])
    if (!file.dependencies.some((entry) => entry.name.toLowerCase() === name))
      throw new ConfigurationError(`Unknown dependency: ${name}`);
  const selected = file.dependencies.filter(
    (entry) => !only || only.includes(entry.name.toLowerCase()),
  );
  assertBindingsUsed(
    options.tokens ?? [],
    selected.map((entry) => entry.mcpEndpoint),
  );
  return mapBounded(selected, async (entry): Promise<BaselineSetOutcome> => {
    const path = baselinePathFor(file, entry);
    try {
      if (!options.force && (await stat(path).catch(() => null)))
        return { ...entry, status: 'kept' };
      const baseline = await createBaseline(
        entry.url,
        entry.mcpEndpoint ?? undefined,
        options.inspector,
        options.now,
        credentialFor(options.tokens ?? [], entry.mcpEndpoint),
      );
      await writeAtomic(path, `${canonicalJson(baseline)}\n`, true);
      return { ...entry, status: 'written' };
    } catch (error) {
      return {
        ...entry,
        status: 'error',
        kind: errorKind(error),
        message: errorMessage(error),
      };
    }
  });
}

export type AcceptInput = {
  dependency: string;
  change: string;
  reason: string;
  /** YYYY-MM-DD, or a number of days from today. */
  expires: string | number;
  by?: string;
};

/**
 * Records one accepted change in the dependencies file, replacing an earlier
 * acceptance of the same change. The file is validated before and after and
 * rewritten with two-space JSON.
 */
export async function acceptChange(
  path: string,
  input: AcceptInput,
  now: Date = new Date(),
): Promise<Acceptance> {
  const file = await loadDependencies(path, now);
  const entry = file.dependencies.find(
    (item) => item.name.toLowerCase() === input.dependency.toLowerCase(),
  );
  if (!entry)
    throw new ConfigurationError(`Unknown dependency: ${input.dependency}`);
  if (
    typeof input.expires === 'number' &&
    !(input.expires >= 1 && input.expires <= MAX_ACCEPTANCE_DAYS)
  )
    throw new ConfigurationError(
      `--days must be between 1 and ${MAX_ACCEPTANCE_DAYS}.`,
    );
  const expires =
    typeof input.expires === 'number'
      ? new Date(now.getTime() + input.expires * 86_400_000)
          .toISOString()
          .slice(0, 10)
      : input.expires;
  if (expires < now.toISOString().slice(0, 10))
    throw new ConfigurationError(`--expires ${expires} is in the past.`);
  const acceptance: Acceptance = {
    dependency: entry.name,
    change: input.change,
    reason: input.reason,
    expires,
    ...(input.by ? { by: input.by } : {}),
  };
  const raw = (await readJsonFile(path, 'Dependencies')) as {
    accepted?: Acceptance[];
  };
  raw.accepted = [
    ...(raw.accepted ?? []).filter(
      (item) =>
        !(
          item.change === acceptance.change &&
          item.dependency.toLowerCase() === entry.name.toLowerCase()
        ),
    ),
    acceptance,
  ];
  const contents = `${JSON.stringify(raw, null, 2)}\n`;
  const parsed = dependenciesSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigurationError(
      `The acceptance is invalid${issue ? ` at ${issue.path.join('.')}: ${issue.message}` : '.'}`,
    );
  }
  try {
    validateDecisions(
      parsed.data.rules ?? [],
      parsed.data.accepted ?? [],
      new Set(file.dependencies.map((item) => item.name.toLowerCase())),
      now,
    );
  } catch (error) {
    if (error instanceof DependenciesDocumentError)
      throw new ConfigurationError(error.message);
    throw error;
  }
  await writeAtomic(path, contents, true);
  return acceptance;
}
