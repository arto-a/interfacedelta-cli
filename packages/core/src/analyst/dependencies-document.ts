import { isAbsolute, normalize, sep } from 'node:path';
import { z } from 'zod/v3';
import {
  KNOWN_CODES,
  type Acceptance,
  type Guard,
  type Rule,
} from './decision-rules';

/**
 * The repository's dependencies document (interfacedelta-dependencies-v1):
 * the schema and the checks that need no file system, shared by the CLI and
 * the hosted service so both accept and decide exactly the same files.
 */
export const DEPENDENCIES_FORMAT_VERSION =
  'interfacedelta-dependencies-v1' as const;
export const MAX_DEPENDENCIES = 50;

/** A dependencies document that fails validation; the message is user-facing. */
export class DependenciesDocumentError extends Error {
  override name = 'DependenciesDocumentError';
}

export type DependencyEntry = {
  name: string;
  url: string;
  mcpEndpoint: string | null;
  /** Baseline path as written in the dependencies file. */
  baseline: string;
  /** Who acts on this dependency's changes, unless a rule names someone. */
  owner?: string;
};

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

export const dependenciesSchema = z
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

/** A validated dependencies document, without its file path. */
export type DependenciesDocument = {
  failOn?: string;
  onError?: string;
  /** Default owner for every dependency. */
  owner?: string;
  dependencies: DependencyEntry[];
  rules: Rule[];
  accepted: Acceptance[];
};

/**
 * Validates a parsed dependencies document. `checkBaseline` adds the checks
 * that need the file's location (the CLI's), run for each dependency after
 * its name is checked and before baselines are compared, and returns an
 * error message or nothing.
 */
export function parseDependenciesDocument(
  input: unknown,
  now: Date = new Date(),
  checkBaseline?: (baseline: string) => string | undefined,
): DependenciesDocument {
  const parsed = dependenciesSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DependenciesDocumentError(
      `Dependencies file is invalid${issue ? ` at ${issue.path.join('.') || 'root'}: ${issue.message}` : '.'}`,
    );
  }
  const names = new Set<string>(),
    baselines = new Set<string>();
  for (const item of parsed.data.dependencies) {
    if (names.has(item.name.toLowerCase()))
      throw new DependenciesDocumentError(
        `Duplicate dependency name: ${item.name}`,
      );
    const problem = checkBaseline?.(item.baseline);
    if (problem) throw new DependenciesDocumentError(problem);
    // Case-insensitive file systems would make A.json and a.json one file.
    const baseline = normalize(item.baseline).toLowerCase();
    if (baselines.has(baseline))
      throw new DependenciesDocumentError(
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
export function validateDecisions(
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
      throw new DependenciesDocumentError(`Duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    if (catchAll)
      throw new DependenciesDocumentError(
        `Rule ${rule.id} can never match: rule ${catchAll} before it matches every change.`,
      );
    for (const name of rule.when.dependency ?? [])
      if (!known(name))
        throw new DependenciesDocumentError(
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
      throw new DependenciesDocumentError(
        `An acceptance names an unknown dependency: ${item.dependency}`,
      );
    const key = `${item.dependency.toLowerCase()} ${item.change}`;
    if (seen.has(key))
      throw new DependenciesDocumentError(
        `${item.change} is accepted twice for ${item.dependency}.`,
      );
    seen.add(key);
    if (item.expires > horizon)
      throw new DependenciesDocumentError(
        `The acceptance of ${item.change} runs past ${horizon}; acceptances last at most a year, so use an allow rule for a permanent decision.`,
      );
  }
}

/** The rules, acceptances and owner that apply to one dependency. */
export const guardFor = (
  file: Pick<DependenciesDocument, 'owner' | 'rules' | 'accepted'>,
  entry: DependencyEntry,
  now?: () => Date,
): Guard => ({
  dependency: entry.name,
  ...((entry.owner ?? file.owner) ? { owner: entry.owner ?? file.owner } : {}),
  rules: file.rules,
  accepted: file.accepted,
  ...(now ? { now } : {}),
});
