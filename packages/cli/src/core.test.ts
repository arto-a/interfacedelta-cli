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
import {
  computePassportFingerprint,
  type PassportComparison,
} from '@interfacedelta/core';

const comparison = (
  classification:
    'breaking' | 'non_breaking' | 'informational' | 'indeterminate',
): PassportComparison => ({
  state: 'changed',
  ruleVersion: 'compatibility-rules-v1',
  previousFingerprint: 'a'.repeat(64),
  currentFingerprint: 'b'.repeat(64),
  changes: [
    {
      semanticId: 'change:test',
      code: 'TEST',
      classification,
      entityKind: 'capability',
      entityId: 'fixture',
      path: 'capabilities',
      reasonCode: 'TEST',
      before: null,
      after: null,
    },
  ],
  counts: {
    breaking: classification === 'breaking' ? 1 : 0,
    nonBreaking: classification === 'non_breaking' ? 1 : 0,
    informational: classification === 'informational' ? 1 : 0,
    indeterminate: classification === 'indeterminate' ? 1 : 0,
  },
  highestClassification: classification,
  changeSetFingerprint: {
    algorithm: 'sha256',
    canonicalization: 'RFC8785',
    projectionVersion: 'passport-change-set-v1',
    value: 'c'.repeat(64),
  },
});

describe('InterfaceDelta baseline and ci-policy-v2', () => {
  it('creates, validates, and checks an unchanged versioned baseline', async () => {
    const passport = passportFixture();
    const baseline = await createBaseline(
      'https://example.com',
      undefined,
      async () => passport,
      () => new Date('2026-08-19T01:02:03.000Z'),
    );
    expect(baseline.formatVersion).toBe('interfacedelta-baseline-v2');
    expect(validateBaseline(baseline).fingerprint.value).toBe(
      passport.fingerprints.passport.value,
    );
    const result = await checkBaseline('https://example.com', baseline, {
      inspector: async () => passport,
    });
    expect(result.comparison.state).toBe('unchanged');
    expect(result.policy).toMatchObject({
      version: 'ci-policy-v2',
      failOn: ['breaking'],
      result: 'passed',
    });
  });

  it('rejects malformed, fingerprint-mismatched, incompatible, and scope-mismatched baselines', async () => {
    const passport = passportFixture();
    const baseline = await createBaseline(
      'https://example.com',
      undefined,
      async () => passport,
    );
    expect(() => validateBaseline({})).toThrow(ConfigurationError);
    expect(() =>
      validateBaseline({
        ...baseline,
        fingerprint: { algorithm: 'sha256', value: 'f'.repeat(64) },
      }),
    ).toThrow(/fingerprint/);
    expect(() =>
      validateBaseline({ ...baseline, formatVersion: 'future' }),
    ).toThrow(/unsupported/);
    await expect(
      checkBaseline('https://example.org', baseline, {
        inspector: async () => passport,
      }),
    ).rejects.toThrow(
      /does not match the baseline \(origin: baseline "https:\/\/example.com", now "https:\/\/example.org"\)/,
    );
    await expect(
      checkBaseline('https://example.com', baseline, {
        mcpEndpoint: 'https://example.com/mcp',
        inspector: async () => passport,
      }),
    ).rejects.toThrow(
      /\(MCP endpoint: baseline null, now "https:\/\/example.com\/mcp"\)/,
    );
  });

  it('names the fix when a baseline was recorded with an earlier Passport version', async () => {
    const passport = passportFixture();
    const baseline = await createBaseline(
      'https://example.com',
      undefined,
      async () => passport,
    );
    const retained = {
      ...baseline.passport,
      schemaVersion: '0.4.0' as const,
      protocols: baseline.passport.protocols.filter(
        (item) => item.protocol !== 'webmcp',
      ),
      capabilities: baseline.passport.capabilities.map((item) => ({
        ...item,
        fingerprint: {
          ...item.fingerprint,
          projectionVersion: 'capability-semantic-v3' as const,
        },
      })),
      fingerprints: {
        passport: {
          ...baseline.passport.fingerprints.passport,
          projectionVersion: 'passport-semantic-v3' as const,
        },
      },
    };
    const value = computePassportFingerprint(retained);
    retained.fingerprints.passport.value = value;
    expect(() =>
      validateBaseline({
        ...baseline,
        passport: retained,
        fingerprint: { algorithm: 'sha256', value },
      }),
    ).toThrow(/Passport 0\.4\.0.*Regenerate it with "interfacedelta baseline"/);
  });

  it('implements the exact default and strict policy classifications', () => {
    expect(applyPolicy(comparison('breaking'), parseFailOn()).result).toBe(
      'failed',
    );
    expect(applyPolicy(comparison('indeterminate'), parseFailOn()).result).toBe(
      'passed',
    );
    expect(applyPolicy(comparison('non_breaking'), parseFailOn()).result).toBe(
      'passed',
    );
    expect(applyPolicy(comparison('informational'), parseFailOn()).result).toBe(
      'passed',
    );
    expect(
      applyPolicy(
        comparison('indeterminate'),
        parseFailOn('breaking,indeterminate'),
      ).result,
    ).toBe('failed');
    expect(() => parseFailOn('anything')).toThrow(ConfigurationError);
  });
});
