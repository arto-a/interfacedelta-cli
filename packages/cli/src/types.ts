import type { AgentPassport } from '@interfacedelta/contracts';
import type {
  MonitoredTargetScope,
  PassportComparison,
} from '@interfacedelta/core';
import type { Decision, Subject } from './guard';
import packageJson from '../package.json' with { type: 'json' };

/** Read from package.json so the CLI, HELP, baselines and npm agree. */
export const CLI_VERSION = packageJson.version;
export const BASELINE_FORMAT_VERSION = 'interfacedelta-baseline-v2' as const;
export const INSPECTION_FORMAT_VERSION =
  'interfacedelta-inspection-v2' as const;
export const CHECK_FORMAT_VERSION = 'interfacedelta-check-v2' as const;
export const CHECK_SET_FORMAT_VERSION = 'interfacedelta-check-set-v1' as const;
/** Single-URL `--json` output when an inspection error was only warned. */
export const CHECK_ERROR_FORMAT_VERSION =
  'interfacedelta-check-error-v1' as const;
export {
  DEPENDENCIES_FORMAT_VERSION,
  type DependencyEntry,
  type FailSelector,
} from '@interfacedelta/core';
import type {
  DependencyEntry,
  FailSelector,
} from '@interfacedelta/core';
export const CI_POLICY_VERSION = 'ci-policy-v2' as const;

export type BaselineArtifact = {
  formatVersion: typeof BASELINE_FORMAT_VERSION;
  generatedAt: string;
  cliVersion: string;
  targetScope: MonitoredTargetScope;
  /** Origin and path the CLI inspected; never a query or fragment. */
  inspectionUrl: string;
  /** Whether a named bearer credential was sent to the MCP endpoint. */
  authenticated: boolean;
  passport: AgentPassport;
  fingerprint: {
    algorithm: 'sha256';
    value: string;
  };
};

export type OnError = 'fail' | 'warn';
export type PolicyResult = 'passed' | 'failed';
export type CheckResult = {
  formatVersion: typeof CHECK_FORMAT_VERSION;
  targetScope: MonitoredTargetScope;
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
    version: typeof CI_POLICY_VERSION;
    rulesVersion: 'decision-rules-v1';
    failOn: FailSelector[];
    /** `failed` when any decision blocks. */
    result: PolicyResult;
  };
};

/** `internal` is an unexpected failure; unlike `inspection`, on-error never downgrades it. */
/** `skipped`: a fork pull request had no secret for a bound token; never fails. */
export type ErrorKind =
  'configuration' | 'credentials' | 'skipped' | 'inspection' | 'internal';
export type DependencyOutcome = DependencyEntry &
  (
    | { status: 'checked'; result: CheckResult }
    | { status: 'error'; error: { kind: ErrorKind; message: string } }
  );
export type CheckSetResult = {
  formatVersion: typeof CHECK_SET_FORMAT_VERSION;
  policy: {
    version: typeof CI_POLICY_VERSION;
    failOn: FailSelector[];
    onError: OnError;
  };
  result: 'passed' | 'failed' | 'error';
  exitCode: 0 | 1 | 2 | 3;
  counts: PassportComparison['counts'] & {
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
