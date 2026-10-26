import {
  canonicalJson,
  comparePassports,
  computePassportFingerprint,
  ConstrainedHttpsClient,
  createMonitoredTargetScope,
  createTargetScope,
  EndpointCredentialClient,
  HttpPassiveMcpClient,
  inspectOrigin,
  isBearerToken,
  monitoredPagePath,
  monitoredTargetScopeSchema,
  normalizeDiscoveryReport,
  resolveInspectionUrlType,
  scopeMonitoredPage,
  type MonitoredTargetScope,
  type PassportComparison,
} from '@interfacedelta/core';
import {
  PASSPORT_SCHEMA_VERSION,
  STRUCTURED_PASSPORT_VERSIONS,
  passportSchema,
  structuredPassportSchema,
  type AgentPassport,
  type DiscoveryReport,
} from '@interfacedelta/contracts';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import {
  ConfigurationError,
  CredentialError,
  CredentialUnavailableError,
  InspectionError,
} from './errors';
import {
  decide,
  DECISION_RULES_VERSION,
  subjectsFor,
  type Guard,
} from './guard';
import { assertNoSecret, registerSecret } from './secrets';
import {
  BASELINE_FORMAT_VERSION,
  CHECK_FORMAT_VERSION,
  CI_POLICY_VERSION,
  CLI_VERSION,
  INSPECTION_FORMAT_VERSION,
  type BaselineArtifact,
  type CheckResult,
  type FailSelector,
  type OnError,
} from './types';

export type Inspector = (
  url: string,
  mcpEndpoint?: string,
  /** The watched same-origin page whose WebMCP forms enter the Passport. */
  monitoredPage?: string | null,
  /** Sent as a bearer token to `mcpEndpoint` only, never elsewhere. */
  bearerToken?: string,
) => Promise<AgentPassport>;

export const TOKEN_VARIABLE_PREFIX = 'INTERFACEDELTA_TOKEN_';
const TOKEN_VARIABLE = /^INTERFACEDELTA_TOKEN_[A-Z0-9_]{1,100}$/;
export const TOKEN_MIN_LENGTH = 16;

/** A bearer token allowed for one MCP endpoint, or every endpoint on an origin. */
export type TokenBinding = {
  origin: string;
  /** Set when the binding names an exact endpoint URL. */
  endpoint?: string;
  variable: string;
};

/**
 * Parses `<https-origin>=INTERFACEDELTA_TOKEN_<NAME>` bindings. They come only
 * from the invocation (CLI flags, Action inputs), never from a repository
 * file, so a checked-out repository cannot choose which secret is read or
 * where it is sent. The prefix keeps runner and cloud credentials out of
 * reach even when a binding is written carelessly.
 */
export function parseTokenBindings(values: readonly string[]): TokenBinding[] {
  const bindings: TokenBinding[] = [];
  for (const value of values) {
    const at = value.lastIndexOf('=');
    const origin = value.slice(0, at),
      variable = value.slice(at + 1);
    if (at <= 0 || !TOKEN_VARIABLE.test(variable))
      throw new ConfigurationError(
        `A token binding is <https-origin>=${TOKEN_VARIABLE_PREFIX}<NAME>.`,
      );
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigurationError(
        `Token binding origin is not a URL: ${origin}`,
      );
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new ConfigurationError(
        `A token binding names an HTTPS origin or MCP endpoint URL: ${origin}`,
      );
    let binding: TokenBinding;
    try {
      const scope = createTargetScope(parsed.origin, parsed.href);
      // A path binds one exact endpoint; a bare origin binds every explicit
      // endpoint on it.
      binding =
        parsed.pathname === '/'
          ? { origin: scope.origin, variable }
          : {
              origin: scope.origin,
              endpoint: scope.explicitMcpEndpoint!,
              variable,
            };
    } catch (error) {
      throw new ConfigurationError(
        error instanceof Error
          ? error.message
          : 'Token binding origin is invalid.',
      );
    }
    const key = (item: TokenBinding) => item.endpoint ?? item.origin;
    if (bindings.some((item) => key(item) === key(binding)))
      throw new ConfigurationError(`Two token bindings name ${key(binding)}.`);
    bindings.push(binding);
  }
  return bindings;
}

/**
 * A pull request GitHub runs without repository secrets: one from a fork
 * (including a deleted fork) or one opened by Dependabot.
 */
export function isForkPullRequest(env: NodeJS.ProcessEnv = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || !env.GITHUB_EVENT_PATH)
    return false;
  if (env.GITHUB_ACTOR === 'dependabot[bot]') return true;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as {
      pull_request?: {
        head?: { repo?: { full_name?: unknown } | null };
        base?: { repo?: { full_name?: unknown } };
      };
    };
    const headRepo = event.pull_request?.head?.repo;
    const base = event.pull_request?.base?.repo?.full_name;
    if (typeof base !== 'string') return false;
    if (headRepo === null) return true;
    const head = headRepo?.full_name;
    return typeof head === 'string' && head !== base;
  } catch {
    return false;
  }
}

/** The binding that applies to an explicit MCP endpoint: exact first, then origin. */
export function bindingFor(
  bindings: readonly TokenBinding[],
  mcpEndpoint: string | null | undefined,
): TokenBinding | undefined {
  if (!mcpEndpoint || !bindings.length) return undefined;
  let endpoint: string;
  try {
    endpoint = createTargetScope(mcpEndpoint, mcpEndpoint).explicitMcpEndpoint!;
  } catch (error) {
    throw new ConfigurationError(
      error instanceof Error ? error.message : 'MCP endpoint is invalid.',
    );
  }
  const origin = new URL(endpoint).origin;
  return (
    bindings.find((item) => item.endpoint === endpoint) ??
    bindings.find((item) => !item.endpoint && item.origin === origin)
  );
}

/** Fails when a binding applies to none of the endpoints: a typo, never a public run. */
export function assertBindingsUsed(
  bindings: readonly TokenBinding[],
  mcpEndpoints: readonly (string | null | undefined)[],
) {
  const used = new Set(
    mcpEndpoints.map((endpoint) => bindingFor(bindings, endpoint)),
  );
  const unused = bindings.filter((item) => !used.has(item));
  if (unused.length)
    throw new ConfigurationError(
      `No explicit MCP endpoint matches --token ${unused.map((item) => item.endpoint ?? item.origin).join(', ')}; set mcpEndpoint (or --mcp-endpoint) on that origin.`,
    );
}

/**
 * The bearer token bound to an explicit MCP endpoint's origin, if any. The
 * value is registered so no output can carry it, and never echoed in errors.
 */
export function credentialFor(
  bindings: readonly TokenBinding[],
  mcpEndpoint: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const binding = bindingFor(bindings, mcpEndpoint);
  if (!binding) return undefined;
  const value = env[binding.variable];
  if (!value) {
    if (isForkPullRequest(env))
      throw new CredentialUnavailableError(
        `${binding.variable} is not available to a pull request from a fork; this target was skipped.`,
      );
    throw new CredentialError(`${binding.variable} is not set.`);
  }
  if ([...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\x7f'))
    throw new ConfigurationError(
      `${binding.variable} contains terminal control characters (for example arrow keys captured while pasting); save it again.`,
    );
  if (value !== value.trim())
    throw new ConfigurationError(
      `${binding.variable} has surrounding whitespace or a newline; remove it.`,
    );
  if (value.length < TOKEN_MIN_LENGTH)
    throw new ConfigurationError(
      `${binding.variable} is too short to be a credential.`,
    );
  if (!isBearerToken(value))
    throw new ConfigurationError(
      `${binding.variable} does not hold a valid bearer token.`,
    );
  registerSecret(value);
  return value;
}

/** A named credential must reach its endpoint and be accepted there. */
export function assertCredentialAccepted(
  report: DiscoveryReport,
  endpointHref: string,
  sent: boolean,
  redirectedTo?: string,
) {
  if (!sent)
    throw new CredentialError(
      'The bearer token was not sent: the MCP endpoint was never requested.',
    );
  // The token went to the first hop only, so whatever answered after a
  // redirect answered without it: that view is not a signed-in one.
  if (redirectedTo)
    throw new CredentialError(
      `The MCP endpoint redirected to ${redirectedTo}; set mcpEndpoint to that URL.`,
    );
  const candidate = report.mcp.candidates.find(
    (item) => item.endpoint === endpointHref,
  );
  if (!candidate)
    throw new CredentialError(
      'The bearer token was sent, but the MCP endpoint was not observed.',
    );
  if (SIGNED_IN.has(candidate.status)) return;
  // No HTTP response at all is an outage, which on-error may downgrade. Any
  // answer other than a working MCP session (400 invalid_token, 401, 403,
  // 404, 5xx) means the signed-in view was not observed.
  if (!reportAnswered(candidate))
    throw new InspectionError(
      'The MCP endpoint could not be reached with the bearer token; nothing was compared.',
    );
  const status = candidate.auth?.httpStatus;
  throw new CredentialError(
    status === 401 || status === 403
      ? `The MCP endpoint refused the bearer token (HTTP ${status}).`
      : `The MCP endpoint did not answer the signed-in request (${candidate.status}); nothing was compared.`,
  );
}

/** Candidate states that prove the signed-in session worked. */
const SIGNED_IN = new Set(['valid', 'payment_required', 'truncated']);

export const localInspector: Inspector = async (
  url,
  mcpEndpoint,
  monitoredPage,
  bearerToken,
) => {
  try {
    // The CLI names itself, so a publisher can tell it from hosted inspection.
    const client = new ConstrainedHttpsClient(undefined, undefined, {
      userAgent: `InterfaceDelta-CLI/${CLI_VERSION}`,
    });
    // The credential client wraps only the MCP client: discovery documents,
    // pages and server cards are fetched without it.
    const credentialed =
      bearerToken && mcpEndpoint
        ? new EndpointCredentialClient(
            client,
            new URL(createTargetScope(url, mcpEndpoint).explicitMcpEndpoint!),
            bearerToken,
          )
        : undefined;
    const report = await inspectOrigin(
      url,
      client,
      undefined,
      mcpEndpoint,
      new HttpPassiveMcpClient(credentialed ?? client, {
        name: 'InterfaceDelta-CLI',
        version: CLI_VERSION,
      }),
    );
    if (!reportAnswered(report))
      throw new InspectionError(
        `No interface on ${report.origin} answered; nothing was compared. Check the URL, that the host resolves, and your network.`,
      );
    if (credentialed)
      assertCredentialAccepted(
        report,
        credentialed.endpointHref,
        credentialed.sent,
        credentialed.redirectedTo,
      );
    return normalizeDiscoveryReport(report, { monitoredPage });
  } catch (error) {
    if (
      error instanceof InspectionError ||
      error instanceof CredentialError ||
      error instanceof ConfigurationError
    )
      throw error;
    throw new InspectionError(
      error instanceof Error ? error.message : 'Inspection failed.',
    );
  }
};

export type ResolvedTarget = {
  targetScope: MonitoredTargetScope;
  inspectionUrl: string;
  monitoredPage: string | null;
};

/**
 * Hosted scope rules: a service URL with an inner path watches that page
 * (target-scope-v2); everything else is the origin (target-scope-v1).
 */
export function resolveTarget(
  url: string,
  mcpEndpoint?: string,
): ResolvedTarget {
  try {
    let submitted: URL;
    try {
      submitted = new URL(url);
    } catch {
      throw new ConfigurationError(
        `Not a URL: ${url}. Give the full address, starting with https://.`,
      );
    }
    if (submitted.search || submitted.hash)
      throw new ConfigurationError(
        'Target URLs must not carry a query or fragment.',
      );
    const monitoredPage =
      resolveInspectionUrlType(submitted, 'auto') === 'service'
        ? monitoredPagePath(url)
        : null;
    const targetScope = createMonitoredTargetScope(
      url,
      mcpEndpoint,
      monitoredPage,
    );
    const inspected = new URL(targetScope.origin);
    inspected.pathname = submitted.pathname;
    return {
      targetScope,
      inspectionUrl: `${inspected.origin}${inspected.pathname}`,
      monitoredPage,
    };
  } catch (error) {
    throw new ConfigurationError(
      error instanceof Error ? error.message : 'Target scope is invalid.',
    );
  }
}

export async function inspectForDistribution(
  url: string,
  mcpEndpoint?: string,
  inspector: Inspector = localInspector,
  bearerToken?: string,
) {
  const target = resolveTarget(url, mcpEndpoint);
  const passport = passportSchema.parse(
    await inspector(url, mcpEndpoint, target.monitoredPage, bearerToken),
  );
  return {
    formatVersion: INSPECTION_FORMAT_VERSION,
    targetScope: target.targetScope,
    inspectionUrl: target.inspectionUrl,
    authenticated: Boolean(bearerToken),
    passport,
  };
}

/**
 * True when any request in the report got an HTTP response (a 404, 401 or
 * redirect counts). A report with none is an outage, not an interface:
 * comparing it would report every surface as removed.
 */
export function reportAnswered(report: unknown): boolean {
  if (Array.isArray(report)) return report.some(reportAnswered);
  if (report === null || typeof report !== 'object') return false;
  return Object.entries(report).some(([key, value]) =>
    key === 'httpStatus' ? typeof value === 'number' : reportAnswered(value),
  );
}

export async function createBaseline(
  url: string,
  mcpEndpoint?: string,
  inspector: Inspector = localInspector,
  now: () => Date = () => new Date(),
  bearerToken?: string,
): Promise<BaselineArtifact> {
  const inspected = await inspectForDistribution(
    url,
    mcpEndpoint,
    inspector,
    bearerToken,
  );
  const computed = computePassportFingerprint(inspected.passport);
  if (computed !== inspected.passport.fingerprints.passport.value)
    throw new InspectionError(
      'Current Passport fingerprint validation failed.',
    );
  const baseline: BaselineArtifact = {
    formatVersion: BASELINE_FORMAT_VERSION,
    generatedAt: now().toISOString(),
    cliVersion: CLI_VERSION,
    targetScope: inspected.targetScope,
    inspectionUrl: inspected.inspectionUrl,
    authenticated: Boolean(bearerToken),
    passport: inspected.passport,
    fingerprint: { algorithm: 'sha256', value: computed },
  };
  assertNoSecret(canonicalJson(baseline), 'baseline');
  return baseline;
}

const baselineSchema = z
  .object({
    formatVersion: z.literal(BASELINE_FORMAT_VERSION),
    generatedAt: z.string().datetime(),
    cliVersion: z.string().min(1),
    targetScope: monitoredTargetScopeSchema,
    inspectionUrl: z.string().url().max(4096),
    // Baselines written before sign-in support were all public views.
    authenticated: z.boolean().default(false),
    passport: structuredPassportSchema,
    fingerprint: z
      .object({
        algorithm: z.literal('sha256'),
        value: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export function validateBaseline(input: unknown): BaselineArtifact {
  if (
    input !== null &&
    typeof input === 'object' &&
    (input as { formatVersion?: unknown }).formatVersion ===
      'interfacedelta-baseline-v1'
  )
    throw new ConfigurationError(
      'Baseline uses interfacedelta-baseline-v1; this CLI reads interfacedelta-baseline-v2. Regenerate it with "interfacedelta baseline".',
    );
  const parsed = baselineSchema.safeParse(input);
  if (!parsed.success)
    throw new ConfigurationError(
      'Baseline format is malformed or unsupported.',
    );
  const computed = computePassportFingerprint(parsed.data.passport);
  if (
    computed !== parsed.data.fingerprint.value ||
    computed !== parsed.data.passport.fingerprints.passport.value
  )
    throw new ConfigurationError(
      'Baseline fingerprint does not match its Passport.',
    );
  if (
    parsed.data.passport.schemaVersion !== PASSPORT_SCHEMA_VERSION ||
    parsed.data.passport.fingerprints.passport.projectionVersion !==
      STRUCTURED_PASSPORT_VERSIONS[PASSPORT_SCHEMA_VERSION].passport
  )
    throw new ConfigurationError(
      `Baseline uses Passport ${parsed.data.passport.schemaVersion}; this CLI compares Passport ${PASSPORT_SCHEMA_VERSION}. Regenerate it with "interfacedelta baseline".`,
    );
  return parsed.data as BaselineArtifact;
}

const FAIL_SELECTORS: readonly FailSelector[] = [
  'breaking',
  'non_breaking',
  'indeterminate',
  'informational',
  'metadata',
];

export function parseFailOn(value = 'breaking'): FailSelector[] {
  const values = [...new Set(value.split(',').map((item) => item.trim()))];
  if (
    values.length === 0 ||
    values.some((item) => !FAIL_SELECTORS.includes(item as FailSelector))
  )
    throw new ConfigurationError(
      `fail-on must be a comma-separated list of ${FAIL_SELECTORS.join(', ')}.`,
    );
  return values as FailSelector[];
}

export function parseOnError(value = 'fail'): OnError {
  if (value !== 'fail' && value !== 'warn')
    throw new ConfigurationError('on-error must be fail or warn.');
  return value;
}

type Change = PassportComparison['changes'][number];

/** `metadata` selects publisher text changes: names, titles, descriptions. */
export const changeMatches = (change: Change, failOn: FailSelector[]) =>
  failOn.includes(change.classification) ||
  (failOn.includes('metadata') &&
    change.code === 'CAPABILITY_METADATA_CHANGED');

export function applyPolicy(
  comparison: PassportComparison,
  failOn: FailSelector[],
) {
  const failed = comparison.changes.some((change) =>
    changeMatches(change, failOn),
  );
  return {
    version: CI_POLICY_VERSION,
    rulesVersion: DECISION_RULES_VERSION,
    failOn,
    result: failed ? ('failed' as const) : ('passed' as const),
  };
}

const SCOPE_FIELDS: Record<string, string> = {
  origin: 'origin',
  explicitMcpEndpoint: 'MCP endpoint',
  monitoredPage: 'watched page',
  scopeVersion: 'target scope version',
};

/** Names what differs, so the fix (a flag or a new baseline) is obvious. */
function scopeMismatch(current: object, recorded: object): string {
  const a = current as Record<string, unknown>,
    b = recorded as Record<string, unknown>;
  const differing = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(
      (key) => canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null),
    )
    .map(
      (key) =>
        `${SCOPE_FIELDS[key] ?? key}: baseline ${JSON.stringify(b[key] ?? null)}, now ${JSON.stringify(a[key] ?? null)}`,
    );
  return `The target does not match the baseline (${differing.join('; ')}). Use the same URL and MCP endpoint, or record a new baseline.`;
}

export async function checkBaseline(
  url: string,
  baselineInput: unknown,
  options: {
    mcpEndpoint?: string;
    failOn?: string;
    inspector?: Inspector;
    bearerToken?: string;
    /** Rules, acceptances and owner from a dependencies file. */
    guard?: Guard;
  } = {},
): Promise<CheckResult> {
  const failOn = parseFailOn(options.failOn);
  const baseline = validateBaseline(baselineInput);
  const target = resolveTarget(url, options.mcpEndpoint);
  if (canonicalJson(target.targetScope) !== canonicalJson(baseline.targetScope))
    throw new ConfigurationError(
      scopeMismatch(target.targetScope, baseline.targetScope),
    );
  if (target.inspectionUrl !== baseline.inspectionUrl)
    throw new ConfigurationError(
      'Current URL does not match the URL the baseline inspected.',
    );
  // A signed-in view and a public one differ by design; never compare them.
  if (baseline.authenticated !== Boolean(options.bearerToken))
    throw new ConfigurationError(
      baseline.authenticated
        ? 'The baseline was recorded with a bearer token; configure the same one.'
        : 'The baseline was recorded without a bearer token; regenerate it with the token.',
    );
  const current = await (options.inspector ?? localInspector)(
    url,
    options.mcpEndpoint,
    scopeMonitoredPage(target.targetScope),
    options.bearerToken,
  );
  const parsedCurrent = passportSchema.parse(current);
  if (
    computePassportFingerprint(parsedCurrent) !==
    parsedCurrent.fingerprints.passport.value
  )
    throw new InspectionError(
      'Current Passport fingerprint validation failed.',
    );
  const comparison = comparePassports(baseline.passport, parsedCurrent);
  if (comparison.state === 'incompatible_version')
    throw new ConfigurationError(
      'Baseline and current canonical representations are incompatible.',
    );
  const subjects = subjectsFor(
    [baseline.passport, parsedCurrent],
    comparison.changes,
  );
  // Only the supplied endpoint receives the token; other endpoints stay public.
  if (baseline.authenticated)
    for (const item of [
      ...baseline.passport.endpoints,
      ...parsedCurrent.endpoints,
    ])
      if (
        item.declarationSources.includes('user_supplied') &&
        subjects[item.id]
      )
        subjects[item.id]!.signedIn = true;
  const { decisions, notes } = decide(
    comparison.changes,
    subjects,
    failOn,
    comparison.state,
    options.guard,
  );
  const result: CheckResult = {
    formatVersion: CHECK_FORMAT_VERSION,
    targetScope: target.targetScope,
    inspectionUrl: target.inspectionUrl,
    previousFingerprint: baseline.fingerprint.value,
    currentFingerprint: parsedCurrent.fingerprints.passport.value,
    comparison,
    authenticated: baseline.authenticated,
    subjects,
    decisions,
    notes,
    policy: {
      version: CI_POLICY_VERSION,
      rulesVersion: DECISION_RULES_VERSION,
      failOn,
      result: decisions.some((item) => item.action === 'block')
        ? 'failed'
        : 'passed',
    },
  };
  assertNoSecret(canonicalJson(result), 'check result');
  return result;
}
