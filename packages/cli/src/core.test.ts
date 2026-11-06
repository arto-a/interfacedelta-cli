import { describe, expect, it } from 'vitest';
import {
  applyPolicy,
  resolveTarget,
  checkBaseline,
  createBaseline,
  parseFailOn,
  validateBaseline,
} from './core';
import { ConfigurationError } from './errors';
import { passportFixture } from './test-fixture';
import {
  computePassportFingerprint,
  resolveTarget as resolveSharedTarget,
  TargetResolutionError,
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

describe('shared target resolution preserves CLI behavior', () => {
  it.each([
    [
      'not-a-url',
      undefined,
      'Not a URL: not-a-url. Give the full address, starting with https://.',
    ],
    [
      'https://example.com?x=1',
      undefined,
      'Target URLs must not carry a query or fragment.',
    ],
    [
      'https://example.com/#section',
      undefined,
      'Target URLs must not carry a query or fragment.',
    ],
    ['https://example.com', 'not-a-url', 'Invalid URL'],
    [
      'https://example.com',
      'http://example.com/mcp',
      'Only HTTPS URLs are supported.',
    ],
  ])('keeps exact error text for %s / %s', (url, endpoint, message) => {
    expect(() => resolveTarget(url!, endpoint)).toThrow(
      new ConfigurationError(message),
    );
    expect(() => resolveTarget(url!, endpoint)).toThrow(ConfigurationError);
    expect(() => resolveSharedTarget(url!, endpoint)).toThrow(
      TargetResolutionError,
    );
    expect(() => resolveSharedTarget(url!, endpoint)).toThrow(message);
  });
  it.each([
    ['https://EXAMPLE.com:443', undefined, null, null, 'https://example.com/'],
    [
      'https://example.com/pricing',
      undefined,
      '/pricing',
      null,
      'https://example.com/pricing',
    ],
    [
      'https://example.com/mcp',
      undefined,
      null,
      null,
      'https://example.com/mcp',
    ],
    [
      'https://example.com',
      'https://other.example.com/mcp',
      null,
      'https://other.example.com/mcp',
      'https://example.com/',
    ],
    [
      'https://example.com',
      'https://example.com/mcp?x=1',
      null,
      'https://example.com/mcp?x=1',
      'https://example.com/',
    ],
    [
      'https://example.com',
      'https://example.com/mcp#section',
      null,
      'https://example.com/mcp',
      'https://example.com/',
    ],
  ])(
    'keeps exact resolved target for %s / %s',
    (url, endpoint, page, explicit, inspectionUrl) => {
      const expected = {
        targetScope: {
          scopeVersion: page ? 'target-scope-v2' : 'target-scope-v1',
          origin: 'https://example.com',
          explicitMcpEndpoint: explicit,
          ...(page ? { monitoredPage: page } : {}),
        },
        inspectionUrl,
        monitoredPage: page,
      };
      expect(resolveTarget(url!, endpoint ?? undefined)).toEqual(expected);
      expect(resolveSharedTarget(url!, endpoint ?? undefined)).toEqual(
        expected,
      );
    },
  );
});

it.each([false, true])(
  'accepts and compares baseline version pairs across commerce rollout (reverse=%s)',
  async (reverse) => {
    const legacy = passportFixture();
    legacy.ucpObservation = 'not_found';
    const commerce = structuredClone(legacy);
    commerce.schemaVersion = '0.6.0';
    commerce.fingerprints.passport.projectionVersion = 'passport-semantic-v5';
    commerce.commerce = {
      ucp: {
        version: '2026-08-25',
        services: [],
        capabilities: [
          { name: 'dev.ucp.shopping.checkout', version: '2026-08-25' },
        ],
        paymentHandlers: [],
      },
    };
    commerce.ucpObservation = 'valid';
    commerce.fingerprints.passport.value = computePassportFingerprint(commerce);
    const [before, after] = reverse ? [commerce, legacy] : [legacy, commerce];
    const baseline = await createBaseline(
      'https://example.com',
      undefined,
      async () => before,
    );
    expect(validateBaseline(baseline)).toEqual(baseline);
    const result = await checkBaseline('https://example.com', baseline, {
      inspector: async () => after,
    });
    expect(result.comparison.state).toBe('changed');
    expect(result.comparison.changes.map((c) => c.code)).toContain(
      reverse ? 'UCP_CAPABILITY_REMOVED' : 'UCP_CAPABILITY_ADDED',
    );
  },
);

it('compares an unchanged 0.6.0 commerce Passport baseline cleanly', async () => {
  const passport = passportFixture();
  passport.schemaVersion = '0.6.0';
  passport.fingerprints.passport.projectionVersion = 'passport-semantic-v5';
  passport.ucpObservation = 'valid';
  passport.commerce = {
    ucp: {
      version: '2026-08-25',
      services: [],
      capabilities: [
        { name: 'dev.ucp.shopping.checkout', version: '2026-08-25' },
      ],
      paymentHandlers: [],
    },
  };
  passport.fingerprints.passport.value = computePassportFingerprint(passport);
  const baseline = await createBaseline(
    'https://example.com',
    undefined,
    async () => passport,
  );
  expect(validateBaseline(baseline)).toEqual(baseline);
  const result = await checkBaseline('https://example.com', baseline, {
    inspector: async () => structuredClone(passport),
  });
  expect(result.comparison.state).toBe('unchanged');
  expect(result.comparison.changes).toEqual([]);
  expect(result.policy.result).toBe('passed');
});

it('supports ACP in the new reader and proves the CLI 0.5.0 reader rejects it', async () => {
  const { z } = await import('zod');
  const { validateAcp } = await import('@interfacedelta/core');
  // RFC 5.1 discovery example (ACP spec 7fdd78df), the first entry of the
  // app's acp-examples.json fixture, inlined so the public CLI tree is
  // self-contained.
  const examples = [
    {
      protocol: {
        name: 'acp',
        version: '2026-01-30',
        supported_versions: [
          '2025-09-29',
          '2025-12-12',
          '2026-01-16',
          '2026-01-30',
        ],
        documentation_url: 'https://agenticcommerce.dev',
      },
      api_base_url: 'https://acp.stripe.com/api',
      transports: ['rest', 'mcp'],
      capabilities: {
        services: ['checkout', 'orders', 'delegate_payment', 'carts'],
        extensions: [
          {
            name: 'discount',
            spec: 'https://agenticcommerce.dev/specs/discount',
            schema: 'https://agenticcommerce.dev/schemas/discount.json',
          },
          {
            name: 'fulfillment',
            spec: 'https://agenticcommerce.dev/specs/fulfillment',
            schema: 'https://agenticcommerce.dev/schemas/fulfillment.json',
          },
        ],
        intervention_types: ['3ds', 'biometric', 'address_verification'],
        supported_currencies: ['usd', 'eur', 'gbp'],
        supported_locales: ['en-US', 'fr-FR', 'de-DE'],
      },
    },
  ];
  const passport = passportFixture();
  passport.schemaVersion = '0.7.0';
  passport.fingerprints.passport.projectionVersion = 'passport-semantic-v6';
  passport.commerce = { acp: validateAcp(examples[0]).summary };
  passport.acpObservation = 'valid';
  passport.protocols.push({
    protocol: 'acp',
    status: 'valid',
    artifactRefs: [],
    endpointRefs: [],
  });
  passport.fingerprints.passport.value = computePassportFingerprint(passport);
  const baseline = await createBaseline(
    'https://example.com',
    undefined,
    async () => passport,
  );
  expect(validateBaseline(baseline)).toEqual(baseline);
  // Frozen rejection constraints from published interfacedelta@0.5.0 (npm
  // tarball SHA1 74ff656b65fef702d05e9262cd4bbca831c6b1d4). This is a
  // rejection oracle, not a replacement implementation of the old reader.
  const oldReaderConstraints = z.object({
    schemaVersion: z.enum(['0.4.0', '0.5.0', '0.6.0']),
    protocols: z.array(
      z.object({
        protocol: z.enum([
          'ard',
          'a2a',
          'mcp',
          'mcp-server-card',
          'openapi',
          'webmcp',
          'ucp',
          'ap2',
        ]),
      }),
    ),
  });
  expect(oldReaderConstraints.safeParse(passport).success).toBe(false);
  expect(
    oldReaderConstraints.safeParse({ ...passport, schemaVersion: '0.6.0' })
      .success,
  ).toBe(false);
  // Optional local released bundle audit; never downloads or inspects a target.
  const releasedModule = process.env.INTERFACEDELTA_CLI_050_MODULE;
  if (releasedModule) {
    const released = (await import(/* @vite-ignore */ releasedModule)) as {
      validateBaseline(input: unknown): unknown;
    };
    expect(() => released.validateBaseline(baseline)).toThrow(
      'Baseline format is malformed or unsupported.',
    );
    const legacy = await createBaseline(
      'https://example.com',
      undefined,
      async () => passportFixture(),
    );
    expect(released.validateBaseline(legacy)).toEqual(legacy);
    const disguised = structuredClone(passport);
    disguised.schemaVersion = '0.6.0';
    disguised.fingerprints.passport.projectionVersion = 'passport-semantic-v5';
    disguised.protocols = disguised.protocols.filter(
      (p) => p.protocol !== 'acp',
    );
    disguised.fingerprints.passport.value =
      computePassportFingerprint(disguised);
    const disguisedBaseline = await createBaseline(
      'https://example.com',
      undefined,
      async () => disguised,
    );
    expect(() => released.validateBaseline(disguisedBaseline)).toThrow(
      'Baseline fingerprint does not match its Passport.',
    );
  }
});
