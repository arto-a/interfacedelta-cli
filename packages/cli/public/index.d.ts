export type ChangeClassification =
  'breaking' | 'non_breaking' | 'informational' | 'indeterminate';
export type CanonicalPassport = Record<string, unknown> & {
  schemaVersion: string;
  fingerprints: {
    passport: { value: string; projectionVersion: string; complete: boolean };
  };
};
export type TargetScope =
  | {
      scopeVersion: 'target-scope-v1';
      origin: string;
      explicitMcpEndpoint: string | null;
    }
  | {
      scopeVersion: 'target-scope-v2';
      origin: string;
      explicitMcpEndpoint: string | null;
      monitoredPage: string;
    };
export type ChangeEvent = {
  semanticId: string;
  code: string;
  classification: ChangeClassification;
  entityKind: string;
  entityId: string;
  path: string;
  reasonCode: string;
  before: unknown;
  after: unknown;
};
export type ChangeCounts = {
  breaking: number;
  nonBreaking: number;
  informational: number;
  indeterminate: number;
};
export type PassportComparison = {
  state: 'baseline' | 'unchanged' | 'changed' | 'incompatible_version';
  ruleVersion: string;
  previousFingerprint: string | null;
  currentFingerprint: string;
  changes: ChangeEvent[];
  counts: ChangeCounts;
  highestClassification: ChangeClassification | 'none';
  changeSetFingerprint: {
    algorithm: 'sha256';
    canonicalization: string;
    projectionVersion: string;
    value: string;
  };
};
export type BaselineArtifact = {
  formatVersion: 'interfacedelta-baseline-v2';
  generatedAt: string;
  cliVersion: string;
  targetScope: TargetScope;
  /** Origin and path the CLI inspected; never a query or fragment. */
  inspectionUrl: string;
  /** Whether a named bearer credential was sent to the MCP endpoint. */
  authenticated: boolean;
  passport: CanonicalPassport;
  fingerprint: { algorithm: 'sha256'; value: string };
};
/** A change classification, or `metadata`: publisher text such as tool descriptions. */
export type FailSelector = ChangeClassification | 'metadata';
export type OnError = 'fail' | 'warn';
export type CheckResult = {
  formatVersion: 'interfacedelta-check-v2';
  targetScope: TargetScope;
  inspectionUrl: string;
  previousFingerprint: string;
  currentFingerprint: string;
  comparison: PassportComparison;
  /** True when the check was signed in with a bearer token, like its baseline. */
  authenticated: boolean;
  /** Names of the capabilities and endpoints the changes touch, by entityId. */
  subjects: Record<string, Subject>;
  /** One decision per change, in `comparison.changes` order. */
  decisions: Decision[];
  /** Acceptances that expired or no longer match. */
  notes: string[];
  policy: {
    version: 'ci-policy-v2';
    rulesVersion: 'decision-rules-v1';
    failOn: FailSelector[];
    /** `failed` when any decision blocks. */
    result: 'passed' | 'failed';
  };
};
export type GuardAction = 'block' | 'warn' | 'allow';
export type Domain = 'product' | 'security_compliance' | 'finance';
export type Attention = 'review_first' | 'review' | 'for_the_record';
export type Rule = {
  id: string;
  when: {
    dependency?: string[];
    classification?: string[];
    code?: string[];
    domain?: Domain[];
    name?: string[];
  };
  then: GuardAction;
  owner?: string;
  note?: string;
};
export type Acceptance = {
  dependency: string;
  change: string;
  reason: string;
  expires: string;
  by?: string;
};
export type Guard = {
  dependency?: string;
  owner?: string;
  rules?: readonly Rule[];
  accepted?: readonly Acceptance[];
  now?: () => Date;
};
export type Subject = {
  kind: string;
  name: string;
  /** The endpoint the bearer token was sent to: its access changes describe the signed-in view. */
  signedIn?: true;
};
export type Decision = {
  change: string;
  action: GuardAction;
  source: 'acceptance' | 'rule' | 'policy';
  rule?: string;
  owner?: string;
  note?: string;
  accepted?: { reason: string; expires: string; by?: string };
  card: { attention: Attention; domains: Domain[]; step: string };
};
export type AcceptInput = {
  dependency: string;
  change: string;
  reason: string;
  expires: string | number;
  by?: string;
};
/** `skipped`: a fork pull request had no secret for a bound token; never fails. */
export type ErrorKind =
  'configuration' | 'credentials' | 'skipped' | 'inspection' | 'internal';
export type DependencyEntry = {
  name: string;
  url: string;
  mcpEndpoint: string | null;
  baseline: string;
  owner?: string;
};
export type DependencyOutcome = DependencyEntry &
  (
    | { status: 'checked'; result: CheckResult }
    | { status: 'error'; error: { kind: ErrorKind; message: string } }
  );
export type CheckSetResult = {
  formatVersion: 'interfacedelta-check-set-v1';
  policy: { version: 'ci-policy-v2'; failOn: FailSelector[]; onError: OnError };
  result: 'passed' | 'failed' | 'error';
  /** 0 pass, 1 policy failure, 2 configuration error, 3 inspection error. */
  exitCode: 0 | 1 | 2 | 3;
  counts: ChangeCounts & {
    dependencies: number;
    failed: number;
    errored: number;
    skipped: number;
    blocked: number;
    warned: number;
    accepted: number;
  };
  dependencies: DependencyOutcome[];
};
export type DependenciesFile = {
  path: string;
  failOn?: string;
  onError?: string;
  owner?: string;
  dependencies: DependencyEntry[];
  rules: Rule[];
  accepted: Acceptance[];
};
export type BaselineSetOutcome = DependencyEntry & {
  status: 'written' | 'kept' | 'error';
  kind?: ErrorKind;
  message?: string;
};
export type SarifEntry = {
  name?: string;
  baselineUri: string;
  result?: CheckResult;
  error?: string;
};
export type Inspector = (
  url: string,
  mcpEndpoint?: string,
  monitoredPage?: string | null,
  /** Sent as a bearer token to `mcpEndpoint` only. */
  bearerToken?: string,
) => Promise<CanonicalPassport>;
export const CLI_VERSION: '0.2.1';
export const BASELINE_FORMAT_VERSION: 'interfacedelta-baseline-v2';
export const INSPECTION_FORMAT_VERSION: 'interfacedelta-inspection-v2';
export const CHECK_FORMAT_VERSION: 'interfacedelta-check-v2';
export const CHECK_SET_FORMAT_VERSION: 'interfacedelta-check-set-v1';
export const CHECK_ERROR_FORMAT_VERSION: 'interfacedelta-check-error-v1';
export const DEPENDENCIES_FORMAT_VERSION: 'interfacedelta-dependencies-v1';
export const CI_POLICY_VERSION: 'ci-policy-v2';
export const DEFAULT_DEPENDENCIES_PATH: string;
export const MAX_DEPENDENCIES: number;
export class ConfigurationError extends Error {
  readonly exitCode: 2;
}
export class InspectionError extends Error {
  readonly exitCode: 3;
}
/** A bound credential is missing, refused, unused or redirected; always fails. */
export class CredentialError extends Error {
  readonly exitCode: 2;
}
/** A pull request from a fork has no secrets; the target is skipped. */
export class CredentialUnavailableError extends Error {
  readonly exitCode: 2;
}
export function exitCodeFor(error: unknown): number;
export function localInspector(
  url: string,
  mcpEndpoint?: string,
  monitoredPage?: string | null,
  bearerToken?: string,
): Promise<CanonicalPassport>;
/** A bearer token allowed for MCP endpoints on one origin. */
export type TokenBinding = {
  origin: string;
  /** Set when the binding names an exact endpoint URL. */
  endpoint?: string;
  variable: string;
};
export const TOKEN_VARIABLE_PREFIX: 'INTERFACEDELTA_TOKEN_';
export const TOKEN_MIN_LENGTH: number;
/** Parses `<https-origin>=INTERFACEDELTA_TOKEN_<NAME>` invocation bindings. */
export function parseTokenBindings(values: readonly string[]): TokenBinding[];
/** True in a GitHub Actions pull request run without secrets: a fork, a deleted fork, or Dependabot. */
export function isForkPullRequest(
  env?: Record<string, string | undefined>,
): boolean;
/** The binding that applies to an explicit MCP endpoint: exact first, then origin. */
export function bindingFor(
  bindings: readonly TokenBinding[],
  mcpEndpoint: string | null | undefined,
): TokenBinding | undefined;
/** Throws a ConfigurationError for any binding no endpoint uses. */
export function assertBindingsUsed(
  bindings: readonly TokenBinding[],
  mcpEndpoints: readonly (string | null | undefined)[],
): void;
/** The bearer token bound to an explicit MCP endpoint's origin, if any. */
export function credentialFor(
  bindings: readonly TokenBinding[],
  mcpEndpoint: string | null | undefined,
  env?: Record<string, string | undefined>,
): string | undefined;
/** Throws a CredentialError unless the token was sent to its endpoint and not refused. */
export function assertCredentialAccepted(
  report: unknown,
  endpointHref: string,
  sent: boolean,
  redirectedTo?: string,
): void;
/** Replaces every registered credential value with `***`. */
export function redact(text: string): string;
/** Error kinds that on-error: warn reports without failing the run. */
export function downgradable(kind: ErrorKind): boolean;
export function resolveTarget(
  url: string,
  mcpEndpoint?: string,
): {
  targetScope: TargetScope;
  inspectionUrl: string;
  monitoredPage: string | null;
};
export function inspectForDistribution(
  url: string,
  mcpEndpoint?: string,
  inspector?: Inspector,
  bearerToken?: string,
): Promise<{
  formatVersion: 'interfacedelta-inspection-v2';
  targetScope: TargetScope;
  inspectionUrl: string;
  authenticated: boolean;
  passport: CanonicalPassport;
}>;
export function createBaseline(
  url: string,
  mcpEndpoint?: string,
  inspector?: Inspector,
  now?: () => Date,
  bearerToken?: string,
): Promise<BaselineArtifact>;
export function validateBaseline(input: unknown): BaselineArtifact;
/** True when any request in a discovery report got an HTTP response. */
export function reportAnswered(report: unknown): boolean;
export function parseFailOn(value?: string): FailSelector[];
export function parseOnError(value?: string): OnError;
export function changeMatches(
  change: ChangeEvent,
  failOn: FailSelector[],
): boolean;
export function applyPolicy(
  comparison: PassportComparison,
  failOn: FailSelector[],
): CheckResult['policy'];
export function checkBaseline(
  url: string,
  baseline: unknown,
  options?: {
    mcpEndpoint?: string;
    failOn?: string;
    inspector?: Inspector;
    bearerToken?: string;
    guard?: Guard;
  },
): Promise<CheckResult>;
export function loadDependencies(
  path?: string,
  now?: Date,
): Promise<DependenciesFile>;
/** The rules, acceptances and owner that apply to one dependency. */
export function guardFor(
  file: DependenciesFile,
  entry: DependencyEntry,
  now?: () => Date,
): Guard;
/** Records one accepted change in the dependencies file. */
export function acceptChange(
  path: string,
  input: AcceptInput,
  now?: Date,
): Promise<Acceptance>;
export const MAX_RULES: number;
export const MAX_ACCEPTANCES: number;
export const MAX_ACCEPTANCE_DAYS: number;
export const DECISION_RULES_VERSION: 'decision-rules-v1';
export const GUARD_ACTIONS: readonly GuardAction[];
export const DOMAINS: readonly Domain[];
/** Every compatibility change code a rule may name. */
export const KNOWN_CODES: ReadonlySet<string>;
/** Names for the capabilities and endpoints the changes touch. */
export function subjectsFor(
  passports: readonly CanonicalPassport[],
  changes: readonly ChangeEvent[],
): Record<string, Subject>;
/** `*` matches any run of characters; linear time. */
export function wildcardMatch(pattern: string, text: string): boolean;
export function ruleMatches(
  rule: Rule,
  change: ChangeEvent,
  domains: readonly Domain[],
  subject: Subject | undefined,
  dependency: string | undefined,
): boolean;
/** One decision per change: acceptance, then first matching rule, then fail-on policy. */
export function decide(
  changes: readonly ChangeEvent[],
  subjects: Readonly<Record<string, Subject>>,
  failOn: FailSelector[],
  comparisonState: string,
  guard?: Guard,
): { decisions: Decision[]; notes: string[] };
/** `mcp.tool create_pull_request`, or the entity id when no name is known. */
export function subjectLabel(result: CheckResult, change: ChangeEvent): string;
export function baselinePathFor(
  file: DependenciesFile,
  entry: DependencyEntry,
): string;
export function checkDependencies(
  file: DependenciesFile,
  options?: {
    failOn?: string;
    onError?: string;
    inspector?: Inspector;
    tokens?: readonly TokenBinding[];
    now?: () => Date;
  },
): Promise<CheckSetResult>;
/** Totals and the run's exit code for a set of outcomes. */
export function summarizeOutcomes(
  dependencies: DependencyOutcome[],
  failOn: FailSelector[],
  onError: OnError,
): CheckSetResult;
export function errorKind(error: unknown): ErrorKind;
export function errorMessage(error: unknown): string;
export function writeDependencyBaselines(
  file: DependenciesFile,
  options?: {
    force?: boolean;
    inspector?: Inspector;
    now?: () => Date;
    tokens?: readonly TokenBinding[];
    only?: readonly string[];
  },
): Promise<BaselineSetOutcome[]>;
/** SARIF 2.1.0 log for GitHub code scanning. */
export function toSarif(entries: SarifEntry[]): Record<string, unknown>;
export const SARIF_RESULT_LIMIT: number;
export function sanitizeGithub(value: unknown, maxLength?: number): string;
export function sanitizeTerminal(value: unknown, maxLength?: number): string;
export function machineJson(value: unknown): string;
/** Reads a JSON file; unreadable or invalid files are ConfigurationErrors. */
export function readJsonFile(path: string, label?: string): Promise<unknown>;
/** Writes through a temporary file and rename; refuses an existing file unless `force`. */
export function writeAtomic(
  path: string,
  contents: string,
  force?: boolean,
): Promise<void>;
export function formatInspection(passport: CanonicalPassport): string;
export function formatCheck(result: CheckResult): string;
export function formatCheckSet(result: CheckSetResult): string;
export function formatBaselineSet(outcomes: BaselineSetOutcome[]): string;
/** Deterministic plain-text explanation of a change, or undefined when the evidence cannot name it. Unsanitized. */
export function changeExplanation(
  change: ChangeEvent,
  result?: CheckResult,
): string | undefined;
/** Publisher-declared facts in a Passport (MCP Apps UI, OpenAPI payment, HTTP 402), never exercised. Unsanitized. */
export function declaredFacts(passport: unknown): string[];
/** Maximum changes listed by the human-readable check output. */
export const CHECK_CHANGE_LIMIT: number;
