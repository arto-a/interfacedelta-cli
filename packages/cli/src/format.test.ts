import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@interfacedelta/core';
import type { AgentPassport } from '@interfacedelta/contracts';
import {
  CHECK_CHANGE_LIMIT,
  changeExplanation,
  declaredFacts,
  formatCheck,
  formatInspection,
  machineJson,
} from './format';
import { decide } from './guard';
import { passportFixture } from './test-fixture';
import type { CheckResult } from './types';

type Capability = AgentPassport['capabilities'][number];
type Change = CheckResult['comparison']['changes'][number];

const capability = (
  kind: string,
  protocol: string,
  metadata: Record<string, unknown>,
  id: string,
): Capability =>
  ({
    id,
    kind,
    protocol,
    protocolKey: id,
    name: id,
    sourceRef: 'artifact:x',
    metadata,
    inventory: { complete: true },
    fingerprint: {
      algorithm: 'sha256',
      canonicalization: 'RFC8785',
      projectionVersion: 'capability-semantic-v4',
      value: 'a'.repeat(64),
    },
    provenance: [],
  }) as unknown as Capability;

function richPassport(): AgentPassport {
  const passport = structuredClone(passportFixture());
  passport.capabilities.push(
    capability('mcp.tool', 'mcp', { uiResourceUri: 'ui://app/view' }, 'a'),
    capability('mcp.tool', 'mcp', {}, 'b'),
    capability(
      'openapi.operation',
      'openapi',
      {
        paymentDeclaration: { offers: [{ intent: 'charge', method: 'tempo' }] },
      },
      'c',
    ),
    capability(
      'openapi.operation',
      'openapi',
      { paymentDeclaration: null },
      'd',
    ),
    capability('webmcp.tool', 'webmcp', {}, 'e'),
  );
  passport.endpoints.push({
    id: 'endpoint:mcp:x',
    protocol: 'mcp',
    role: 'mcp.streamable-http',
    url: 'https://example.com/mcp',
    originRelationship: 'same_origin',
    relationship: 'explicitly_inspected',
    declarationSources: [],
    observationStatus: 'payment_required',
    artifactRefs: [],
  } as unknown as AgentPassport['endpoints'][number]);
  return passport;
}

const change = (overrides: Partial<Change> = {}): Change =>
  ({
    code: 'CAPABILITY_REMOVED',
    classification: 'breaking',
    entityKind: 'capability',
    entityId: 'tool:create_order',
    path: 'capabilities',
    reasonCode: 'PREVIOUSLY_PRESENT_CURRENTLY_ABSENT_COMPLETE_INVENTORIES',
    before: null,
    after: null,
    ...overrides,
  }) as Change;

const check = (changes: Change[]): CheckResult => {
  const { decisions, notes } = decide(changes, {}, ['breaking'], 'changed');
  return {
    subjects: {},
    decisions,
    notes,
    formatVersion: 'interfacedelta-check-v2',
    targetScope: {
      scopeVersion: 'target-scope-v1',
      origin: 'https://example.com',
      explicitMcpEndpoint: null,
    },
    inspectionUrl: 'https://example.com/',
    previousFingerprint: 'a'.repeat(64),
    currentFingerprint: 'b'.repeat(64),
    comparison: {
      state: 'changed',
      ruleVersion: 'compatibility-rules-v8',
      previousFingerprint: 'a'.repeat(64),
      currentFingerprint: 'b'.repeat(64),
      changes,
      counts: {
        breaking: changes.length,
        nonBreaking: 0,
        informational: 0,
        indeterminate: 0,
      },
      highestClassification: 'breaking',
      changeSetFingerprint: {
        algorithm: 'sha256',
        canonicalization: 'RFC8785',
        projectionVersion: 'passport-change-set-v1',
        value: 'c'.repeat(64),
      },
    },
    policy: {
      version: 'ci-policy-v2',
      rulesVersion: 'decision-rules-v1',
      failOn: ['breaking'],
      result: 'failed',
    },
  } as unknown as CheckResult;
};

describe('inspection output', () => {
  it('lists OpenAPI and experimental WebMCP, and omits empty sections', () => {
    const text = formatInspection(passportFixture());
    expect(text).toMatch(/^OpenAPI {2}\S/m);
    expect(text).toMatch(/^WebMCP {3}.* \(experimental\)$/m);
    expect(text).not.toContain('Declared');
    expect(text).not.toContain('OpenAPI operation');
    expect(text).not.toContain('WebMCP form tool');
  });

  it('counts OpenAPI and WebMCP capabilities and lists declared facts without prices', () => {
    const text = formatInspection(richPassport());
    expect(text).toContain('2 OpenAPI operations');
    expect(text).toContain('1 WebMCP form tool');
    expect(declaredFacts(richPassport())).toEqual([
      '1 MCP tool declares an MCP Apps UI (not fetched)',
      '1 OpenAPI operation declares payment (publisher-declared; not verified; nothing paid)',
      '1 MCP endpoint answered HTTP 402 (payment required)',
    ]);
    expect(text).toContain('\nDeclared\n1 MCP tool declares an MCP Apps UI');
    expect(text).not.toMatch(/amount|price|\$\d/i);
  });

  it('is deterministic', () => {
    expect(formatInspection(richPassport())).toBe(
      formatInspection(richPassport()),
    );
  });
});

describe('check output', () => {
  it('marks access changes on the signed-in endpoint, and only there', () => {
    const access = (entityId: string) =>
      change({
        code: 'ACCESS_NOW_REQUIRES_PAYMENT',
        entityKind: 'endpoint',
        entityId,
        path: 'endpoints.observationStatus',
        reasonCode: 'PUBLIC_OBSERVATION_NOW_PAYMENT_REQUIRED',
        before: 'valid',
        after: 'payment_required',
      });
    const result = {
      ...check([access('endpoint:bound'), access('endpoint:other')]),
      authenticated: true,
      subjects: {
        'endpoint:bound': {
          kind: 'mcp.endpoint',
          name: 'https://example.com/mcp',
          signedIn: true as const,
        },
        'endpoint:other': {
          kind: 'mcp.endpoint',
          name: 'https://example.com/other',
        },
      },
    };
    const [bound, other] = result.comparison.changes;
    expect(changeExplanation(bound!, result)).toMatch(
      /Observed signed in with the configured token, not as public access\.$/,
    );
    expect(changeExplanation(other!, result)).not.toContain('signed in');
    expect(changeExplanation(bound!)).not.toContain('signed in');
    expect(formatCheck(result)).toContain(
      'mcp.endpoint https://example.com/mcp — ',
    );
    expect(formatCheck(result).match(/Observed signed in/g)?.length).toBe(1);
  });

  it('lists changes with deterministic explanations', () => {
    const text = formatCheck(
      check([
        change({
          code: 'MCP_TOOL_INPUT_SCHEMA_CHANGED',
          classification: 'breaking',
          reasonCode: 'REQUIRED_PROPERTY_ADDED',
          path: '$/properties/currency',
        }),
        change(),
      ]),
    );
    expect(text).toContain('\nChanges\n');
    expect(text).toContain(
      '- BLOCK breaking MCP_TOOL_INPUT_SCHEMA_CHANGED capability: tool:create_order — “currency” is now required',
    );
    expect(text).toContain(
      '- BLOCK breaking CAPABILITY_REMOVED capability: tool:create_order',
    );
    expect(text).toContain(
      '    next: Compare the new input requirements with what your client sends.',
    );
  });

  it(`shows at most ${CHECK_CHANGE_LIMIT} changes and counts the rest`, () => {
    const text = formatCheck(
      check(
        Array.from({ length: 13 }, (_, index) =>
          change({ entityId: `tool:${index}` }),
        ),
      ),
    );
    expect(text.match(/^- BLOCK breaking /gm)).toHaveLength(CHECK_CHANGE_LIMIT);
    expect(text).toContain('- and 3 more');
  });

  it('prints no Changes section when nothing changed', () => {
    expect(formatCheck(check([]))).not.toContain('Changes');
  });

  it('neutralizes hostile remote text', () => {
    const text = formatCheck(
      check([change({ entityId: 'evil\u001b[31mred\nInjected: yes\u0007' })]),
    );
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
    expect(text).not.toMatch(/\nInjected: yes/);
    expect(text).toContain('evilred\\nInjected: yes');
  });

  it('leaves machine JSON byte-identical to canonical JSON', () => {
    const result = check([change()]);
    expect(machineJson(result)).toBe(`${canonicalJson(result)}\n`);
    expect(machineJson(result)).not.toContain('Changes');
  });

  it('returns no explanation when the evidence cannot name the change', () => {
    expect(changeExplanation(change({ code: 'UNKNOWN_FUTURE_CODE' }))).toBe(
      undefined,
    );
  });
});
