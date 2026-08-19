import type { AgentPassport } from '@interfacedelta/contracts';
import type {
  PassportComparison,
  TargetScope,
} from '@interfacedelta/core';

export const CLI_VERSION = '0.1.0' as const;
export const BASELINE_FORMAT_VERSION = 'interfacedelta-baseline-v1' as const;
export const INSPECTION_FORMAT_VERSION = 'interfacedelta-inspection-v1' as const;
export const CHECK_FORMAT_VERSION = 'interfacedelta-check-v1' as const;
export const CI_POLICY_VERSION = 'ci-policy-v1' as const;

export type BaselineArtifact = {
  formatVersion: typeof BASELINE_FORMAT_VERSION;
  generatedAt: string;
  cliVersion: string;
  targetScope: TargetScope;
  passport: AgentPassport;
  fingerprint: {
    algorithm: 'sha256';
    value: string;
  };
};

export type FailClassification = 'breaking' | 'indeterminate';
export type PolicyResult = 'passed' | 'failed';
export type CheckResult = {
  formatVersion: typeof CHECK_FORMAT_VERSION;
  targetScope: TargetScope;
  previousFingerprint: string;
  currentFingerprint: string;
  comparison: PassportComparison;
  policy: {
    version: typeof CI_POLICY_VERSION;
    failOn: FailClassification[];
    result: PolicyResult;
  };
};
