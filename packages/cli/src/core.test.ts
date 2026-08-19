import { describe, expect, it } from 'vitest';
import {
  applyPolicy,
  checkBaseline,
  createBaseline,
  parseFailOn,
  validateBaseline,
} from './core';
import { ConfigurationError } from './errors';
import { passportFixture } from './test-fixture';
import type { PassportComparison } from '@interfacedelta/core';

const comparison = (classification: 'breaking' | 'non_breaking' | 'informational' | 'indeterminate'): PassportComparison => ({
  state: 'changed',
  ruleVersion: 'compatibility-rules-v1',
  previousFingerprint: 'a'.repeat(64),
  currentFingerprint: 'b'.repeat(64),
  changes: [{
    semanticId: 'change:test', code: 'TEST', classification,
    entityKind: 'capability', entityId: 'fixture', path: 'capabilities',
    reasonCode: 'TEST', before: null, after: null,
  }],
  counts: {
    breaking: classification === 'breaking' ? 1 : 0,
    nonBreaking: classification === 'non_breaking' ? 1 : 0,
    informational: classification === 'informational' ? 1 : 0,
    indeterminate: classification === 'indeterminate' ? 1 : 0,
  },
  highestClassification: classification,
  changeSetFingerprint: {
    algorithm: 'sha256', canonicalization: 'RFC8785',
    projectionVersion: 'passport-change-set-v1', value: 'c'.repeat(64),
  },
});

describe('InterfaceDelta baseline and ci-policy-v1', () => {
  it('creates, validates, and checks an unchanged versioned baseline', async () => {
    const passport = passportFixture();
    const baseline = await createBaseline(
      'https://example.com', undefined, async () => passport,
      () => new Date('2026-08-19T01:02:03.000Z'),
    );
    expect(baseline.formatVersion).toBe('interfacedelta-baseline-v1');
    expect(validateBaseline(baseline).fingerprint.value).toBe(passport.fingerprints.passport.value);
    const result = await checkBaseline('https://example.com', baseline, { inspector: async () => passport });
    expect(result.comparison.state).toBe('unchanged');
    expect(result.policy).toMatchObject({ version: 'ci-policy-v1', failOn: ['breaking'], result: 'passed' });
  });

  it('rejects malformed, fingerprint-mismatched, incompatible, and scope-mismatched baselines', async () => {
    const passport = passportFixture();
    const baseline = await createBaseline('https://example.com', undefined, async () => passport);
    expect(() => validateBaseline({})).toThrow(ConfigurationError);
    expect(() => validateBaseline({ ...baseline, fingerprint: { algorithm: 'sha256', value: 'f'.repeat(64) } })).toThrow(/fingerprint/);
    expect(() => validateBaseline({ ...baseline, formatVersion: 'future' })).toThrow(/unsupported/);
    await expect(checkBaseline('https://example.org', baseline, { inspector: async () => passport })).rejects.toThrow(/scope/);
    await expect(checkBaseline('https://example.com', baseline, { mcpEndpoint: 'https://example.com/mcp', inspector: async () => passport })).rejects.toThrow(/scope/);
  });

  it('implements the exact default and strict policy classifications', () => {
    expect(applyPolicy(comparison('breaking'), parseFailOn()).result).toBe('failed');
    expect(applyPolicy(comparison('indeterminate'), parseFailOn()).result).toBe('passed');
    expect(applyPolicy(comparison('non_breaking'), parseFailOn()).result).toBe('passed');
    expect(applyPolicy(comparison('informational'), parseFailOn()).result).toBe('passed');
    expect(applyPolicy(comparison('indeterminate'), parseFailOn('breaking,indeterminate')).result).toBe('failed');
    expect(() => parseFailOn('anything')).toThrow(ConfigurationError);
  });
});
