import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { stat } from 'node:fs/promises';
import { canonicalJson } from '@interfacedelta/core';
import { z } from 'zod';
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
import { KNOWN_CODES, type Acceptance, type Guard, type Rule } from './guard';
import { readJsonFile, writeAtomic } from './io';
import {
  CHECK_SET_FORMAT_VERSION,
  CI_POLICY_VERSION,
  DEPENDENCIES_FORMAT_VERSION,
  type CheckSetResult,
  type DependencyEntry,
  type DependencyOutcome,
  type ErrorKind,
  type FailSelector,
  type OnError,
} from './types';

export const DEFAULT_DEPENDENCIES_PATH = '.interfacedelta/dependencies.json';
export const MAX_DEPENDENCIES = 50;
/** Inspections in flight at once: bounded so one run stays polite. */
const CONCURRENCY = 4;

const baselinePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value.endsWith('.json') &&
      !isAbsolute(value) &&
      !/[\\:]/.test(value) &&
      !normalize(value).split(sep).includes('..'),
    'A baseline is a relative .json path inside the dependencies directory.',
  );

const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => ![...value].some((ch) => ch.charCodeAt(0) < 0x20),
      'must be one line of text',
    );
/**
 * An owner label such as `@acme/payments`. Owners reach the Action's `owners`
 * output, which workflows pass to other steps, so no shell or list syntax.
 */
const ownerLabel = z
  .string()
  .regex(
    /^@?[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/,
    'must be a handle or team such as @acme/payments',
  );
/** A value or a list of values; normalized to a list. */
const oneOrMany = <T extends z.ZodTypeAny>(item: T) =>
  z.union([
    z.array(item).min(1).max(50),
    item.transform((value: z.output<T>) => [value]),
  ]) as unknown as z.ZodType<z.output<T>[], z.ZodTypeDef, unknown>;
export const MAX_RULES = 100;
export const MAX_ACCEPTANCES = 200;
/** Acceptances are temporary; a permanent decision is an allow rule. */
export const MAX_ACCEPTANCE_DAYS = 366;

const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    when: z
      .object({
        dependency: oneOrMany(z.string().min(1).max(64)).optional(),
        classification: oneOrMany(
          z.enum([
            'breaking',
            'non_breaking',
            'indeterminate',
            'informational',
          ]),
        ).optional(),
        code: oneOrMany(
          z
            .string()
            .refine((value) => KNOWN_CODES.has(value), 'is not a change code'),
        ).optional(),
        domain: oneOrMany(
          z.enum(['product', 'security_compliance', 'finance']),
        ).optional(),
        name: oneOrMany(label(200)).optional(),
      })
      .strict(),
    then: z.enum(['block', 'warn', 'allow']),
    owner: ownerLabel.optional(),
    note: label(300).optional(),
  })
  .strict();

const acceptanceSchema = z
  .object({
    dependency: z.string().min(1).max(64),
    change: z.string().regex(/^change:[a-f0-9]{24}$/, 'is not a change id'),
    reason: label(300),
    expires: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (value) =>
          new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
        'is not a calendar date',
      ),
    by: ownerLabel.optional(),
  })
  .strict();

const dependenciesSchema = z
  .object({
    formatVersion: z.literal(DEPENDENCIES_FORMAT_VERSION),
    failOn: z.string().max(200).optional(),
    onError: z.string().max(10).optional(),
    owner: ownerLabel.optional(),
    dependencies: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
            url: z.string().min(1).max(2048),
            mcpEndpoint: z.string().min(1).max(2048).optional(),
            baseline: baselinePathSchema,
            owner: ownerLabel.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_DEPENDENCIES),
    rules: z.array(ruleSchema).max(MAX_RULES).optional(),
    accepted: z.array(acceptanceSchema).max(MAX_ACCEPTANCES).optional(),
  })
  .strict();

export type DependenciesFile = {
  path: string;
  failOn?: string;
  onError?: string;
  /** Default owner for every dependency. */
  owner?: string;
  dependencies: DependencyEntry[];
  rules: Rule[];
  accepted: Acceptance[];
};

export async function loadDependencies(
  path = DEFAULT_DEPENDENCIES_PATH,
  now: Date = new Date(),
): Promise<DependenciesFile> {
  const input = await readJsonFile(path, 'Dependencies');
  const parsed = dependenciesSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigurationError(
      `Dependencies file is invalid${issue ? ` at ${issue.path.join('.') || 'root'}: ${issue.message}` : '.'}`,
    );
  }
  const names = new Set<string>(),
    baselines = new Set<string>();
  const directory = dirname(resolve(path));
  for (const item of parsed.data.dependencies) {
    if (names.has(item.name.toLowerCase()))
      throw new ConfigurationError(`Duplicate dependency name: ${item.name}`);
    const resolved = resolve(directory, item.baseline);
    const inside = relative(directory, resolved);
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      throw new ConfigurationError(
        `Baseline ${item.baseline} is outside the dependencies directory.`,
      );
    if (resolved === resolve(path))
      throw new ConfigurationError(
        `Baseline ${item.baseline} is the dependencies file itself.`,
      );
    // Case-insensitive file systems would make A.json and a.json one file.
    const baseline = normalize(item.baseline).toLowerCase();
    if (baselines.has(baseline))
      throw new ConfigurationError(
        `Two dependencies share the baseline ${item.baseline}.`,
      );
    names.add(item.name.toLowerCase());
    baselines.add(baseline);
  }
  // Rules and acceptances may spell a dependency in any case; decisions
  // compare the canonical name.
  const canonical = new Map(
    parsed.data.dependencies.map((item) => [
      item.name.toLowerCase(),
      item.name,
    ]),
  );
  const named = (name: string) => canonical.get(name.toLowerCase()) ?? name;
  const rules = (parsed.data.rules ?? []).map((rule) => ({
    ...rule,
    when: {
      ...rule.when,
      ...(rule.when.dependency
        ? { dependency: rule.when.dependency.map(named) }
        : {}),
    },
  }));
  const accepted = (parsed.data.accepted ?? []).map((item) => ({
    ...item,
    dependency: named(item.dependency),
  }));
  validateDecisions(rules, accepted, names, now);
  return {
    path,
    failOn: parsed.data.failOn,
    onError: parsed.data.onError,
    ...(parsed.data.owner ? { owner: parsed.data.owner } : {}),
    dependencies: parsed.data.dependencies.map((item) => ({
      name: item.name,
      url: item.url,
      mcpEndpoint: item.mcpEndpoint ?? null,
      baseline: item.baseline,
      ...(item.owner ? { owner: item.owner } : {}),
    })),
    rules,
    accepted,
  };
}

/** Rules and acceptances must name real dependencies and be reachable. */
function validateDecisions(
  rules: readonly Rule[],
  accepted: readonly Acceptance[],
  names: ReadonlySet<string>,
  now: Date,
) {
  const known = (name: string) => names.has(name.toLowerCase());
  const ids = new Set<string>();
  let catchAll: string | undefined;
  for (const rule of rules) {
    if (ids.has(rule.id))
      throw new ConfigurationError(`Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    if (catchAll)
      throw new ConfigurationError(
        `Rule ${rule.id} can never match: rule ${catchAll} before it matches every change.`,
      );
    for (const name of rule.when.dependency ?? [])
      if (!known(name))
        throw new ConfigurationError(
          `Rule ${rule.id} names an unknown dependency: ${name}`,
        );
    if (!Object.keys(rule.when).length) catchAll = rule.id;
  }
  const horizon = new Date(now.getTime() + MAX_ACCEPTANCE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const seen = new Set<string>();
  for (const item of accepted) {
    if (!known(item.dependency))
      throw new ConfigurationError(
        `An acceptance names an unknown dependency: ${item.dependency}`,
      );
    const key = `${item.dependency.toLowerCase()} ${item.change}`;
    if (seen.has(key))
      throw new ConfigurationError(
        `${item.change} is accepted twice for ${item.dependency}.`,
      );
    seen.add(key);
    if (item.expires > horizon)
      throw new ConfigurationError(
        `The acceptance of ${item.change} runs past ${horizon}; acceptances last at most a year, so use an allow rule for a permanent decision.`,
      );
  }
}

/** The rules, acceptances and owner that apply to one dependency. */
export const guardFor = (
  file: DependenciesFile,
  entry: DependencyEntry,
  now?: () => Date,
): Guard => ({
  dependency: entry.name,
  ...((entry.owner ?? file.owner) ? { owner: entry.owner ?? file.owner } : {}),
  rules: file.rules,
  accepted: file.accepted,
  ...(now ? { now } : {}),
});

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
  validateDecisions(
    parsed.data.rules ?? [],
    parsed.data.accepted ?? [],
    new Set(file.dependencies.map((item) => item.name.toLowerCase())),
    now,
  );
  await writeAtomic(path, contents, true);
  return acceptance;
}
