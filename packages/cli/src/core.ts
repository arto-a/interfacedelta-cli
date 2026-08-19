import {
  canonicalJson,
  comparePassports,
  computePassportFingerprint,
  createTargetScope,
  inspectOrigin,
  normalizeDiscoveryReport,
  targetScopeSchema,
  type PassportComparison,
  type TargetScope,
} from '@interfacedelta/core';
import { passportSchema, type AgentPassport } from '@interfacedelta/contracts';
import { z } from 'zod';
import { ConfigurationError, InspectionError } from './errors';
import {
  BASELINE_FORMAT_VERSION,
  CHECK_FORMAT_VERSION,
  CI_POLICY_VERSION,
  CLI_VERSION,
  INSPECTION_FORMAT_VERSION,
  type BaselineArtifact,
  type CheckResult,
  type FailClassification,
} from './types';

export type Inspector = (
  url: string,
  mcpEndpoint?: string,
) => Promise<AgentPassport>;

export const localInspector: Inspector = async (url, mcpEndpoint) => {
  try {
    const report = await inspectOrigin(url, undefined, undefined, mcpEndpoint);
    return normalizeDiscoveryReport(report);
  } catch (error) {
    throw new InspectionError(
      error instanceof Error ? error.message : 'Inspection failed.',
    );
  }
};

export function scopeFor(url: string, mcpEndpoint?: string): TargetScope {
  try {
    return createTargetScope(url, mcpEndpoint);
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
) {
  const targetScope = scopeFor(url, mcpEndpoint);
  const passport = passportSchema.parse(await inspector(url, mcpEndpoint));
  return {
    formatVersion: INSPECTION_FORMAT_VERSION,
    targetScope,
    passport,
  };
}

export async function createBaseline(
  url: string,
  mcpEndpoint?: string,
  inspector: Inspector = localInspector,
  now: () => Date = () => new Date(),
): Promise<BaselineArtifact> {
  const inspected = await inspectForDistribution(url, mcpEndpoint, inspector);
  const computed = computePassportFingerprint(inspected.passport);
  if (computed !== inspected.passport.fingerprints.passport.value)
    throw new InspectionError('Current Passport fingerprint validation failed.');
  return {
    formatVersion: BASELINE_FORMAT_VERSION,
    generatedAt: now().toISOString(),
    cliVersion: CLI_VERSION,
    targetScope: inspected.targetScope,
    passport: inspected.passport,
    fingerprint: { algorithm: 'sha256', value: computed },
  };
}

const baselineSchema = z
  .object({
    formatVersion: z.literal(BASELINE_FORMAT_VERSION),
    generatedAt: z.string().datetime(),
    cliVersion: z.string().min(1),
    targetScope: targetScopeSchema,
    passport: passportSchema,
    fingerprint: z
      .object({
        algorithm: z.literal('sha256'),
        value: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export function validateBaseline(input: unknown): BaselineArtifact {
  const parsed = baselineSchema.safeParse(input);
  if (!parsed.success)
    throw new ConfigurationError('Baseline format is malformed or unsupported.');
  const computed = computePassportFingerprint(parsed.data.passport);
  if (
    computed !== parsed.data.fingerprint.value ||
    computed !== parsed.data.passport.fingerprints.passport.value
  )
    throw new ConfigurationError('Baseline fingerprint does not match its Passport.');
  if (
    parsed.data.passport.schemaVersion !== '0.2.0' ||
    parsed.data.passport.fingerprints.passport.projectionVersion !==
      'passport-semantic-v1'
  )
    throw new ConfigurationError('Baseline canonical representation is incompatible.');
  return parsed.data;
}

export function parseFailOn(value = 'breaking'): FailClassification[] {
  const values = [...new Set(value.split(',').map((item) => item.trim()))];
  if (
    values.length === 0 ||
    values.some((item) => !['breaking', 'indeterminate'].includes(item))
  )
    throw new ConfigurationError(
      'fail-on must be breaking or breaking,indeterminate.',
    );
  return values as FailClassification[];
}

export function applyPolicy(
  comparison: PassportComparison,
  failOn: FailClassification[],
) {
  const failed = failOn.some((classification) =>
    comparison.changes.some((change) => change.classification === classification),
  );
  return {
    version: CI_POLICY_VERSION,
    failOn,
    result: failed ? ('failed' as const) : ('passed' as const),
  };
}

export async function checkBaseline(
  url: string,
  baselineInput: unknown,
  options: {
    mcpEndpoint?: string;
    failOn?: string;
    inspector?: Inspector;
  } = {},
): Promise<CheckResult> {
  const baseline = validateBaseline(baselineInput);
  const targetScope = scopeFor(url, options.mcpEndpoint);
  if (canonicalJson(targetScope) !== canonicalJson(baseline.targetScope))
    throw new ConfigurationError('Current target scope does not match the baseline.');
  const current = await (options.inspector ?? localInspector)(
    url,
    options.mcpEndpoint,
  );
  const parsedCurrent = passportSchema.parse(current);
  if (computePassportFingerprint(parsedCurrent) !== parsedCurrent.fingerprints.passport.value)
    throw new InspectionError('Current Passport fingerprint validation failed.');
  const comparison = comparePassports(baseline.passport, parsedCurrent);
  if (comparison.state === 'incompatible_version')
    throw new ConfigurationError(
      'Baseline and current canonical representations are incompatible.',
    );
  return {
    formatVersion: CHECK_FORMAT_VERSION,
    targetScope,
    previousFingerprint: baseline.fingerprint.value,
    currentFingerprint: parsedCurrent.fingerprints.passport.value,
    comparison,
    policy: applyPolicy(comparison, parseFailOn(options.failOn)),
  };
}
