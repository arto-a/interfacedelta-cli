export type ChangeClassification = 'breaking' | 'non_breaking' | 'informational' | 'indeterminate';
export type CanonicalPassport = Record<string, unknown> & {
  schemaVersion: string;
  fingerprints: { passport: { value: string; projectionVersion: string; complete: boolean } };
};
export type TargetScope = { scopeVersion: 'target-scope-v1'; origin: string; explicitMcpEndpoint: string | null };
export type ChangeEvent = {
  semanticId: string; code: string; classification: ChangeClassification; entityKind: string;
  entityId: string; path: string; reasonCode: string; before: unknown; after: unknown;
};
export type PassportComparison = {
  state: 'baseline' | 'unchanged' | 'changed' | 'incompatible_version';
  ruleVersion: string; previousFingerprint: string | null; currentFingerprint: string;
  changes: ChangeEvent[];
  counts: { breaking: number; nonBreaking: number; informational: number; indeterminate: number };
  highestClassification: ChangeClassification | 'none';
  changeSetFingerprint: { algorithm: 'sha256'; canonicalization: string; projectionVersion: string; value: string };
};
export type BaselineArtifact = {
  formatVersion: 'interfacedelta-baseline-v1'; generatedAt: string; cliVersion: string;
  targetScope: TargetScope; passport: CanonicalPassport;
  fingerprint: { algorithm: 'sha256'; value: string };
};
export type FailClassification = 'breaking' | 'indeterminate';
export type CheckResult = {
  formatVersion: 'interfacedelta-check-v1'; targetScope: TargetScope;
  previousFingerprint: string; currentFingerprint: string; comparison: PassportComparison;
  policy: { version: 'ci-policy-v1'; failOn: FailClassification[]; result: 'passed' | 'failed' };
};
export type Inspector = (url: string, mcpEndpoint?: string) => Promise<CanonicalPassport>;
export const CLI_VERSION: '0.1.0';
export const BASELINE_FORMAT_VERSION: 'interfacedelta-baseline-v1';
export const INSPECTION_FORMAT_VERSION: 'interfacedelta-inspection-v1';
export const CHECK_FORMAT_VERSION: 'interfacedelta-check-v1';
export const CI_POLICY_VERSION: 'ci-policy-v1';
export function localInspector(url: string, mcpEndpoint?: string): Promise<CanonicalPassport>;
export function createBaseline(url: string, mcpEndpoint?: string, inspector?: Inspector, now?: () => Date): Promise<BaselineArtifact>;
export function validateBaseline(input: unknown): BaselineArtifact;
export function checkBaseline(url: string, baseline: unknown, options?: { mcpEndpoint?: string; failOn?: string; inspector?: Inspector }): Promise<CheckResult>;
export function sanitizeGithub(value: unknown, maxLength?: number): string;
export function sanitizeTerminal(value: unknown, maxLength?: number): string;
export function machineJson(value: unknown): string;
