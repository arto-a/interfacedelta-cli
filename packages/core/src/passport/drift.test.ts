import { describe, expect, it } from 'vitest';
import { projectJsonSchema } from '@interfacedelta/schema-compatibility';
import type { AgentPassport } from '@interfacedelta/contracts';
import { normalizeDiscoveryReport } from './normalize';
import { canonicalSha256 } from './canonical-json';
import { comparePassports } from './drift';
import { extractWebMcpDeclarativeTools } from '../discovery/webmcp-html';
import type { DiscoveryReport } from '@interfacedelta/contracts';

const report: DiscoveryReport = {
  inputUrl: 'https://example.com/path?q=1',
  origin: 'https://example.com',
  inspectedAt: '2026-01-01T00:00:00.000Z',
  ard: {
    status: 'not_found',
    discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
    durationMs: 1,
    redirects: [],
    warnings: [],
  },
  a2a: {
    status: 'not_found',
    discoveryUrl: 'https://example.com/.well-known/agent-card.json',
    durationMs: 1,
    redirects: [],
    warnings: [],
  },
  mcp: {
    totalDeclared: 0,
    totalInspected: 0,
    totalOmitted: 0,
    serverCards: [],
    candidates: [],
  },
};
const base = normalizeDiscoveryReport(report);
function passport(change: (draft: AgentPassport) => void): AgentPassport {
  const draft = structuredClone(base);
  change(draft);
  draft.capabilities.sort((a, b) => a.id.localeCompare(b.id));
  draft.inventoryGroups.sort((a, b) => a.id.localeCompare(b.id));
  draft.endpoints.sort((a, b) => a.id.localeCompare(b.id));
  draft.fingerprints.passport.value = canonicalSha256({
    schemaVersion: draft.schemaVersion,
    protocols: draft.protocols,
    endpoints: draft.endpoints,
    inventoryGroups: draft.inventoryGroups,
    capabilities: draft.capabilities,
    identityAssertions: draft.identityAssertions,
    consistency: draft.consistency,
  });
  return draft;
}
const endpoint = {
  id: 'endpoint:mcp',
  protocol: 'mcp' as const,
  role: 'mcp.streamable-http' as const,
  url: 'https://example.com/mcp',
  originRelationship: 'same_origin' as const,
  relationship: 'explicitly_inspected' as const,
  declarationSources: ['user_supplied'],
  observationStatus: 'valid',
  protocolVersion: '2025-11-25',
  artifactRefs: [],
};
const group = (kind: 'mcp.tool' | 'mcp.resource', complete = true) => ({
  id: `inventory:${kind}`,
  kind,
  sourceRef: endpoint.id,
  sourceEndpointId: endpoint.id,
  attempted: true,
  complete,
  itemCount: 1,
  ...(!complete ? { truncatedReason: 'item_limit' } : {}),
});
const tool = (
  name: string,
  description = 'description',
  input = 'a',
  output = 'b',
) => ({
  id: `capability:${name}`,
  kind: 'mcp.tool' as const,
  protocol: 'mcp' as const,
  protocolKey: name,
  name,
  description,
  sourceRef: endpoint.id,
  sourceEndpointId: endpoint.id,
  metadata: { name, inputSchemaSha256: input, outputSchemaSha256: output },
  inventory: { complete: true },
  fingerprint: {
    algorithm: 'sha256' as const,
    canonicalization: 'RFC8785' as const,
    projectionVersion: 'capability-semantic-v4' as const,
    value: canonicalSha256(name),
  },
  provenance: [endpoint.id],
});
const configured = (tools = [tool('alpha')], complete = true) =>
  passport((p) => {
    p.endpoints.push(structuredClone(endpoint));
    p.protocols.find((x) => x.protocol === 'mcp')!.status = 'valid';
    p.protocols.find((x) => x.protocol === 'mcp')!.revision = '2025-11-25';
    p.protocols.find((x) => x.protocol === 'mcp')!.endpointRefs = [endpoint.id];
    p.inventoryGroups.push({
      ...group('mcp.tool', complete),
      itemCount: tools.length,
    });
    p.capabilities.push(...tools);
  });
const codes = (a: AgentPassport, b: AgentPassport) =>
  comparePassports(a, b).changes.map((change) => [
    change.code,
    change.classification,
  ]);

describe('deterministic Passport drift', () => {
  it('does not manufacture breaking drift when equivalent ARD publication moves to v0.91', () => {
    const predecessor: DiscoveryReport = {
      ...report,
      ard: {
        status: 'valid',
        discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
        durationMs: 1,
        redirects: [],
        warnings: [],
        validation: {
          valid: true,
          schemaName: 'ARD predecessor',
          schemaVersion: '0.9',
          schemaRevision: 'old',
          schemaFile: 'old',
          schemaSha256: 'old',
          errors: [],
        },
        summary: {
          specVersion: '1.0',
          entries: 0,
          entryTypes: [],
          hostPresent: false,
          ardVersion: 'predecessor',
          predecessorFallbackUsed: true,
          conformanceWarnings: [],
          mcpServerCardUrls: [],
          mcpServerCardInline: [],
          declarations: [],
        },
      },
    };
    const current: DiscoveryReport = {
      ...report,
      ard: {
        ...predecessor.ard,
        discoveryUrl: 'https://example.com/.well-known/ard.json',
        validation: {
          ...predecessor.ard.validation!,
          schemaName: 'ARD v0.91',
          schemaVersion: 'v0.91',
          schemaRevision: 'new',
        },
        summary: {
          ...predecessor.ard.summary!,
          specVersion: 'v0.91',
          ardVersion: 'v0.91',
          predecessorFallbackUsed: false,
        },
      },
    };
    const result = comparePassports(
      normalizeDiscoveryReport(predecessor),
      normalizeDiscoveryReport(current),
    );
    expect(
      result.changes.some((change) => change.classification === 'breaking'),
    ).toBe(false);
    expect(result.changes.map((change) => change.code)).not.toEqual(
      expect.arrayContaining([
        'CAPABILITY_REMOVED',
        'PROTOCOL_SURFACE_REMOVED',
      ]),
    );
  });
  it('classifies complete capability additions and removals', () => {
    expect(codes(configured([]), configured())).toContainEqual([
      'CAPABILITY_ADDED',
      'non_breaking',
    ]);
    expect(codes(configured(), configured([]))).toContainEqual([
      'CAPABILITY_REMOVED',
      'breaking',
    ]);
  });
  it('suppresses false removals when the current inventory is incomplete', () => {
    const result = codes(configured(), configured([], false));
    expect(result).toContainEqual([
      'INVENTORY_COMPARISON_INDETERMINATE',
      'indeterminate',
    ]);
    expect(result.some(([code]) => code === 'CAPABILITY_REMOVED')).toBe(false);
  });
  it('suppresses false additions when the previous inventory is incomplete', () => {
    const result = codes(configured([], false), configured());
    expect(result).toContainEqual([
      'INVENTORY_COMPARISON_INDETERMINATE',
      'indeterminate',
    ]);
    expect(result.some(([code]) => code === 'CAPABILITY_ADDED')).toBe(false);
  });
  it('isolates completeness by inventory group', () => {
    const before = configured([], true);
    const after = configured([tool('new')], true);
    before.inventoryGroups.push(group('mcp.resource', true));
    after.inventoryGroups.push(group('mcp.resource', false));
    const result = codes(
      passport((p) => Object.assign(p, before)),
      passport((p) => Object.assign(p, after)),
    );
    expect(result).toContainEqual(['CAPABILITY_ADDED', 'non_breaking']);
    expect(result).toContainEqual([
      'INVENTORY_COMPARISON_INDETERMINATE',
      'indeterminate',
    ]);
  });
  it('keeps MCP input and output schema hash changes indeterminate', () => {
    expect(
      codes(
        configured(),
        configured([tool('alpha', 'description', 'changed', 'b')]),
      ),
    ).toContainEqual(['MCP_TOOL_INPUT_SCHEMA_CHANGED', 'indeterminate']);
    expect(
      codes(
        configured(),
        configured([tool('alpha', 'description', 'a', 'changed')]),
      ),
    ).toContainEqual(['MCP_TOOL_OUTPUT_SCHEMA_CHANGED', 'indeterminate']);
  });
  it('uses persisted bounded projections for directional v2 schema findings', () => {
    const projectedTool = (
      inputSchema: unknown,
      outputSchema: unknown,
      inputHash: string,
      outputHash: string,
    ) => {
      const value = tool('alpha', 'description', inputHash, outputHash);
      Object.assign(value.metadata, {
        inputSchemaCompatibility: projectJsonSchema(inputSchema),
        outputSchemaCompatibility: projectJsonSchema(outputSchema),
      });
      return value;
    };
    const previous = configured([
      projectedTool(
        { type: 'number' },
        { type: 'number' },
        'input-number',
        'output-number',
      ),
    ]);
    const current = configured([
      projectedTool(
        { type: 'integer' },
        { type: 'integer' },
        'input-integer',
        'output-integer',
      ),
    ]);
    const first = comparePassports(previous, current);
    expect(first.ruleVersion).toBe('compatibility-rules-v8');
    expect(first.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MCP_TOOL_INPUT_SCHEMA_CHANGED',
          classification: 'breaking',
          path: '$/type',
          reasonCode: 'TYPE_SET_RESTRICTED',
        }),
        expect.objectContaining({
          code: 'MCP_TOOL_OUTPUT_SCHEMA_CHANGED',
          classification: 'non_breaking',
          path: '$/type',
          reasonCode: 'TYPE_SET_RESTRICTED',
        }),
      ]),
    );
    const second = comparePassports(previous, current);
    expect(second.changes).toEqual(first.changes);
    expect(second.changeSetFingerprint).toEqual(first.changeSetFingerprint);
  });
  it('treats description-only changes as informational', () =>
    expect(
      codes(configured(), configured([tool('alpha', 'new description')])),
    ).toContainEqual(['CAPABILITY_METADATA_CHANGED', 'informational']));
  it('classifies endpoint removal but not failure as removal', () => {
    const removed = codes(
      configured(),
      passport(() => {}),
    );
    expect(removed).toContainEqual(['ENDPOINT_REMOVED', 'breaking']);
    expect(removed).toContainEqual(['PROTOCOL_SURFACE_REMOVED', 'breaking']);
    const failed = passport((p) => {
      p.protocols.find((x) => x.protocol === 'mcp')!.status = 'unreachable';
    });
    const result = codes(configured(), failed);
    expect(result).toContainEqual([
      'ENDPOINT_OBSERVATION_FAILED',
      'indeterminate',
    ]);
    expect(result.some(([code]) => code === 'ENDPOINT_REMOVED')).toBe(false);
    expect(result.some(([code]) => code === 'PROTOCOL_SURFACE_REMOVED')).toBe(
      false,
    );
  });
  it.each([
    ['auth_required', 'ACCESS_NOW_REQUIRES_AUTH', 'breaking'],
    ['forbidden', 'ACCESS_NOW_FORBIDDEN', 'breaking'],
    ['payment_required', 'ACCESS_NOW_REQUIRES_PAYMENT', 'breaking'],
  ] as const)(
    'classifies public to %s access',
    (status, code, classification) => {
      const after = configured();
      after.endpoints[0]!.observationStatus = status;
      after.fingerprints.passport.value = canonicalSha256(after.endpoints);
      expect(codes(configured(), after)).toContainEqual([code, classification]);
    },
  );
  it.each(['auth_required', 'forbidden', 'payment_required'])(
    'classifies %s becoming publicly observable as non-breaking',
    (status) => {
      const before = configured();
      before.endpoints[0]!.observationStatus = status;
      before.fingerprints.passport.value = canonicalSha256(before.endpoints);
      expect(codes(before, configured())).toContainEqual([
        'ACCESS_BECAME_PUBLICLY_OBSERVABLE',
        'non_breaking',
      ]);
    },
  );
  it.each([
    ['unreachable', 'payment_required'],
    ['auth_required', 'payment_required'],
    ['payment_required', 'forbidden'],
  ])('leaves %s to %s as an indeterminate state change', (from, to) => {
    const before = configured();
    before.endpoints[0]!.observationStatus = from;
    before.fingerprints.passport.value = canonicalSha256(before.endpoints);
    const after = configured();
    after.endpoints[0]!.observationStatus = to;
    after.fingerprints.passport.value = canonicalSha256(after.endpoints);
    const result = codes(before, after);
    expect(result).toContainEqual([
      'ENDPOINT_OBSERVATION_STATE_CHANGED',
      'indeterminate',
    ]);
    expect(result.some(([, c]) => c === 'breaking')).toBe(false);
  });
  it('defaults protocol version changes to indeterminate', () => {
    const after = configured();
    after.endpoints[0]!.protocolVersion = 'next';
    after.fingerprints.passport.value = canonicalSha256(after.endpoints);
    expect(codes(configured(), after)).toContainEqual([
      'PROTOCOL_VERSION_CHANGED',
      'indeterminate',
    ]);
  });
  it('records identity and consistency changes as informational', () => {
    const before = configured();
    before.consistency.findings.push({
      code: 'ARD_DECLARED_MCP_SERVER_CARD',
      status: 'match',
      subjectRefs: [],
      evidenceRefs: [],
      message: 'match',
    });
    const after = structuredClone(before);
    after.identityAssertions.push({
      id: 'identity:x',
      sourceProtocol: 'mcp',
      sourceRef: endpoint.id,
      assertionType: 'implementation_identity',
      field: 'version',
      value: '2',
      trust: 'self_reported',
    });
    after.consistency.findings[0]!.status = 'mismatch';
    after.fingerprints.passport.value = canonicalSha256({
      identity: after.identityAssertions,
      consistency: after.consistency,
    });
    before.fingerprints.passport.value = canonicalSha256({
      identity: before.identityAssertions,
      consistency: before.consistency,
    });
    const result = codes(before, after);
    expect(result).toContainEqual([
      'IDENTITY_ASSERTION_CHANGED',
      'informational',
    ]);
    expect(result).toContainEqual([
      'CONSISTENCY_FINDING_CHANGED',
      'informational',
    ]);
  });
  it('uses an indeterminate safety net for otherwise unexplained semantic drift', () => {
    const after = structuredClone(base);
    after.fingerprints.passport.value = 'f'.repeat(64);
    expect(codes(base, after)).toEqual([
      ['UNCLASSIFIED_SEMANTIC_CHANGE', 'indeterminate'],
    ]);
  });
  it('never reads an oversized error body reclassified from unreachable to not found as a removal', () => {
    // Previously an oversized 404 body failed as RESPONSE_TOO_LARGE.
    const failure = {
      code: 'RESPONSE_TOO_LARGE' as const,
      message: 'Response exceeds the byte limit.',
    };
    const before = normalizeDiscoveryReport({
      ...report,
      ard: {
        ...report.ard,
        status: 'unreachable',
        discoveryUrl: 'https://example.com/.well-known/ard.json',
        error: failure,
      },
      a2a: { ...report.a2a, status: 'unreachable', error: failure },
    });
    expect(comparePassports(before, base).highestClassification).toBe(
      'indeterminate',
    );
    expect(codes(before, base)).toEqual([
      ['UNCLASSIFIED_SEMANTIC_CHANGE', 'indeterminate'],
    ]);
  });
  it('is deterministic across equivalent array and object ordering', () => {
    const previous = configured([tool('b'), tool('a')]);
    const current = configured([tool('c')]);
    const reorderedPrevious = structuredClone(previous),
      reorderedCurrent = structuredClone(current);
    reorderedPrevious.capabilities.reverse();
    reorderedPrevious.inventoryGroups.reverse();
    reorderedCurrent.capabilities.reverse();
    reorderedCurrent.inventoryGroups.reverse();
    const first = comparePassports(previous, current),
      second = comparePassports(reorderedPrevious, reorderedCurrent);
    expect(second.changes).toEqual(first.changes);
    expect(second.changeSetFingerprint).toEqual(first.changeSetFingerprint);
    expect(first.ruleVersion).toBe('compatibility-rules-v8');
  });
  it('stops at incompatible representation versions', () => {
    const prior = { ...base, schemaVersion: '0.1.0' };
    const result = comparePassports(prior, base);
    expect(result.state).toBe('incompatible_version');
    expect(result.changes).toEqual([]);
  });
  it('classifies directional OpenAPI request and response schemas through projection v1', () => {
    const make = (
      requestType: 'number' | 'integer',
      responseType: 'number' | 'integer',
    ) =>
      passport((p) => {
        p.protocols.find((x) => x.protocol === 'openapi')!.status = 'valid';
        p.inventoryGroups.push({
          id: 'inventory:openapi',
          kind: 'openapi.operation',
          sourceRef: 'artifact:openapi',
          attempted: true,
          complete: true,
          itemCount: 1,
        });
        p.capabilities.push({
          id: 'capability:openapi:post-items',
          kind: 'openapi.operation',
          protocol: 'openapi',
          protocolKey: 'POST /items',
          name: 'createItem',
          sourceRef: 'artifact:openapi',
          metadata: {
            method: 'POST',
            path: '/items',
            parameters: [],
            requestBody: {
              required: false,
              content: [
                {
                  mediaType: 'application/json',
                  schemaSha256: requestType,
                  schemaCompatibility: projectJsonSchema({ type: requestType }),
                },
              ],
            },
            responses: [
              {
                statusKey: '200',
                content: [
                  {
                    mediaType: 'application/json',
                    schemaSha256: responseType,
                    schemaCompatibility: projectJsonSchema({
                      type: responseType,
                    }),
                  },
                ],
              },
            ],
          },
          inventory: { complete: true },
          fingerprint: {
            algorithm: 'sha256',
            canonicalization: 'RFC8785',
            projectionVersion: 'capability-semantic-v4',
            value: canonicalSha256({ requestType, responseType }),
          },
          provenance: ['artifact:openapi'],
        });
      });
    const result = codes(make('number', 'number'), make('integer', 'integer'));
    expect(result).toContainEqual([
      'OPENAPI_REQUEST_SCHEMA_CHANGED',
      'breaking',
    ]);
    expect(result).toContainEqual([
      'OPENAPI_RESPONSE_SCHEMA_CHANGED',
      'non_breaking',
    ]);
  });

  it('classifies OpenAPI requiredness and suppresses operation removals for incomplete inventory', () => {
    const make = (required: boolean, complete = true) =>
      passport((p) => {
        p.protocols.find((x) => x.protocol === 'openapi')!.status = 'valid';
        p.inventoryGroups.push({
          id: 'inventory:openapi',
          kind: 'openapi.operation',
          sourceRef: 'artifact:openapi',
          attempted: true,
          complete,
          itemCount: 1,
          ...(!complete ? { truncatedReason: 'operation_limit' } : {}),
        });
        p.capabilities.push({
          id: 'capability:openapi:get-items',
          kind: 'openapi.operation',
          protocol: 'openapi',
          protocolKey: 'GET /items',
          name: 'listItems',
          sourceRef: 'artifact:openapi',
          metadata: {
            method: 'GET',
            path: '/items',
            parameters: [
              {
                key: 'query:limit',
                required,
                schemaSha256: 'same',
                schemaCompatibility: projectJsonSchema({ type: 'integer' }),
              },
            ],
            responses: [],
          },
          inventory: { complete },
          fingerprint: {
            algorithm: 'sha256',
            canonicalization: 'RFC8785',
            projectionVersion: 'capability-semantic-v4',
            value: canonicalSha256(required),
          },
          provenance: ['artifact:openapi'],
        });
      });
    expect(codes(make(false), make(true))).toContainEqual([
      'OPENAPI_PARAMETER_REQUIREDNESS_CHANGED',
      'breaking',
    ]);
    const current = make(false, false);
    current.capabilities = [];
    current.fingerprints.passport.value = canonicalSha256(current);
    const comparison = comparePassports(make(false), current);
    expect(
      comparison.changes.some(
        (item) => item.code === 'OPENAPI_OPERATION_REMOVED',
      ),
    ).toBe(false);
    expect(
      comparison.changes.some(
        (item) => item.code === 'INVENTORY_COMPARISON_INDETERMINATE',
      ),
    ).toBe(true);
  });

  it('does not fabricate OpenAPI addition across the 0.3.0 representation boundary', () => {
    const prior = structuredClone(base) as unknown as Record<string, unknown>;
    prior.schemaVersion = '0.3.0';
    const fingerprints = prior.fingerprints as {
      passport: { projectionVersion: string };
    };
    fingerprints.passport.projectionVersion = 'passport-semantic-v2';
    const current = passport((p) => {
      p.protocols.find((x) => x.protocol === 'openapi')!.status = 'valid';
    });
    const comparison = comparePassports(prior, current);
    expect(comparison.state).toBe('incompatible_version');
    expect(comparison.changes).toEqual([]);
  });
});

describe('compatibility-rules-v5 WebMCP drift', () => {
  const site = (html?: string, failed = false): AgentPassport => {
    const observed =
      html === undefined
        ? undefined
        : extractWebMcpDeclarativeTools(
            html,
            new URL(report.origin),
            `${report.origin}/`,
          );
    return normalizeDiscoveryReport({
      ...report,
      webmcp:
        observed && failed
          ? {
              ...observed,
              status: 'not_observed',
              reason: 'unreachable',
              tools: [],
              toolCount: 0,
            }
          : observed,
    });
  };
  const book =
    '<form toolname="book" tooldescription="Book"><input name="date"></form>';
  const search = '<form toolname="search"><input name="q"></form>';
  const none = '<main>No tools</main>';

  it('adds WebMCP as a non-breaking surface with no inventory noise', () => {
    const result = comparePassports(site(none), site(book));
    expect(result.changes.map((c) => [c.code, c.classification])).toEqual([
      ['PROTOCOL_SURFACE_ADDED', 'non_breaking'],
    ]);
    expect(result.ruleVersion).toBe('compatibility-rules-v8');
  });
  it('classifies tool removal and addition only between complete inventories', () => {
    expect(codes(site(book + search), site(book))).toContainEqual([
      'CAPABILITY_REMOVED',
      'breaking',
    ]);
    expect(codes(site(book), site(book + search))).toContainEqual([
      'CAPABILITY_ADDED',
      'non_breaking',
    ]);
    const duplicated = site(book + book.replace('date', 'day'));
    const suppressed = codes(site(book + search), duplicated);
    expect(suppressed).toContainEqual([
      'INVENTORY_COMPARISON_INDETERMINATE',
      'indeterminate',
    ]);
    expect(suppressed.some(([code]) => code === 'CAPABILITY_REMOVED')).toBe(
      false,
    );
  });
  it.each([
    ['a complete root page without tools', () => site(none)],
    ['a failed root page fetch', () => site(none, true)],
  ])(
    'never claims removal when declarations vanish after %s',
    (_label, after) => {
      const result = codes(site(book), after());
      expect(result).toEqual([
        ['WEBMCP_DECLARATIONS_NOT_OBSERVED', 'indeterminate'],
      ]);
    },
  );
  it('treats declared form-field changes as indeterminate, not metadata noise', () => {
    const result = codes(
      site(book),
      site(
        '<form toolname="book" tooldescription="Book"><input name="date"><input name="party" required></form>',
      ),
    );
    expect(result).toEqual([['WEBMCP_TOOL_CONTROLS_CHANGED', 'indeterminate']]);
  });
  it('keeps description changes informational', () => {
    expect(
      codes(
        site(book),
        site(
          book.replace('tooldescription="Book"', 'tooldescription="Reserve"'),
        ),
      ),
    ).toEqual([['CAPABILITY_METADATA_CHANGED', 'informational']]);
  });
  it('leaves sites without WebMCP unchanged across root page failures', () => {
    expect(comparePassports(site(none), site(none, true)).state).toBe(
      'unchanged',
    );
    expect(comparePassports(site(), site(none)).state).toBe('unchanged');
  });
  it('treats a retained 0.4.0 Passport as incompatible and emits nothing', () => {
    const current = site(book);
    const prior = {
      ...current,
      schemaVersion: '0.4.0',
      fingerprints: {
        passport: {
          ...current.fingerprints.passport,
          projectionVersion: 'passport-semantic-v3',
        },
      },
    };
    const result = comparePassports(prior, current);
    expect(result.state).toBe('incompatible_version');
    expect(result.changes).toEqual([]);
    expect(result.highestClassification).toBe('none');
  });
});

describe('compatibility-rules-v6 OpenAPI payment declarations', () => {
  const offer = (method = 'tempo', intent = 'charge') => ({
    intent,
    method,
    currency: 'usd',
    pricing: 'fixed',
  });
  const summary = (
    offers = [offer()],
    offersTruncated = false,
    declares402Response = true,
  ) => ({
    offers,
    offersTruncated,
    declares402Response,
    rejectionCodes: [],
  });
  const operation = (
    payment: ReturnType<typeof summary> | undefined,
    {
      groupComplete = true,
      capabilityComplete = true,
      title = 'List items',
      checked = true,
    } = {},
  ) =>
    passport((p) => {
      p.protocols.find((x) => x.protocol === 'openapi')!.status = 'valid';
      p.inventoryGroups.push({
        id: 'inventory:openapi',
        kind: 'openapi.operation',
        sourceRef: 'artifact:openapi',
        attempted: true,
        complete: groupComplete,
        itemCount: 1,
        ...(!groupComplete ? { truncatedReason: 'operation_limit' } : {}),
      });
      p.capabilities.push({
        id: 'capability:openapi:get-items',
        kind: 'openapi.operation',
        protocol: 'openapi',
        protocolKey: 'GET /items',
        name: 'listItems',
        title,
        sourceRef: 'artifact:openapi',
        metadata: {
          method: 'GET',
          path: '/items',
          parameters: [],
          responses: [],
          ...(checked ? { paymentDeclaration: payment ?? null } : {}),
        },
        inventory: { complete: capabilityComplete },
        fingerprint: {
          algorithm: 'sha256',
          canonicalization: 'RFC8785',
          projectionVersion: 'capability-semantic-v4',
          value: canonicalSha256({ payment: payment ?? null, title }),
        },
        provenance: ['artifact:openapi'],
      });
    });
  const paymentCodes = (a: AgentPassport, b: AgentPassport) =>
    codes(a, b).filter(
      ([code]) =>
        code.includes('PAYMENT') || code === 'CAPABILITY_METADATA_CHANGED',
    );

  it('classifies a newly declared payment requirement as breaking', () =>
    expect(paymentCodes(operation(undefined), operation(summary()))).toEqual([
      ['OPENAPI_OPERATION_NOW_REQUIRES_PAYMENT', 'breaking'],
    ]));

  it('classifies a withdrawn payment requirement as non-breaking', () =>
    expect(paymentCodes(operation(summary()), operation(undefined))).toEqual([
      ['OPENAPI_OPERATION_NO_LONGER_REQUIRES_PAYMENT', 'non_breaking'],
    ]));

  it('leaves a changed declaration indeterminate', () =>
    expect(
      paymentCodes(
        operation(summary([offer('tempo')])),
        operation(summary([offer('stripe')])),
      ),
    ).toEqual([['OPENAPI_PAYMENT_DECLARATION_CHANGED', 'indeterminate']]));

  it.each([
    ['incomplete operation inventory', { groupComplete: false }, false],
    ['incomplete operation evidence', { capabilityComplete: false }, false],
    ['truncated offers', {}, true],
  ] as const)(
    'never claims a new requirement from %s',
    (_label, flags, truncated) => {
      const result = comparePassports(
        operation(undefined, flags),
        operation(summary([offer()], truncated), flags),
      ).changes.filter((change) => change.code.includes('PAYMENT'));
      expect(result.map((change) => change.classification)).toEqual([
        'indeterminate',
      ]);
      expect(result[0]!.reasonCode).toBe('PAYMENT_EVIDENCE_INCOMPLETE');
    },
  );

  it('does not claim a requirement from a declaration without a usable offer', () =>
    expect(
      paymentCodes(
        operation(undefined),
        operation(summary([{ ...offer(), method: '' }])),
      ),
    ).toEqual([['OPENAPI_PAYMENT_DECLARATION_CHANGED', 'indeterminate']]));

  it('reports payment through the v6 rule, not as generic metadata', () => {
    const result = paymentCodes(
      operation(undefined, { title: 'Old title' }),
      operation(summary(), { title: 'New title' }),
    );
    expect(result).toContainEqual([
      'OPENAPI_OPERATION_NOW_REQUIRES_PAYMENT',
      'breaking',
    ]);
    const metadata = comparePassports(
      operation(undefined, { title: 'Old title' }),
      operation(summary(), { title: 'New title' }),
    ).changes.find((change) => change.code === 'CAPABILITY_METADATA_CHANGED');
    expect(metadata).toBeDefined();
    expect(JSON.stringify(metadata)).not.toContain('paymentDeclaration');
  });

  it('explains an observer that began reading declarations as one informational event, never breaking', () => {
    const result = comparePassports(
      operation(undefined, { checked: false }),
      operation(summary()),
    );
    expect(
      result.changes.map((change) => [change.code, change.classification]),
    ).toEqual([
      ['OPENAPI_PAYMENT_DECLARATION_COVERAGE_CHANGED', 'informational'],
    ]);
    expect(result.changes[0]!.entityId).toBe(
      'artifact:openapi|openapi.operation',
    );
  });

  it('does not call a declaration without a 402 response breaking', () => {
    const result = comparePassports(
      operation(undefined),
      operation(summary([offer()], false, false)),
    ).changes.filter((change) => change.code.includes('PAYMENT'));
    expect(
      result.map((change) => [change.code, change.classification]),
    ).toEqual([['OPENAPI_PAYMENT_DECLARATION_CHANGED', 'indeterminate']]);
    expect(result[0]!.reasonCode).toBe('PAYMENT_DECLARED_WITHOUT_402_RESPONSE');
  });

  it('emits one coverage event per document however many operations it holds', () => {
    const twoOperations = (
      payment: ReturnType<typeof summary> | undefined,
      checked: boolean,
    ) => {
      const p = operation(payment, { checked });
      const first = p.capabilities.find(
        (c) => c.id === 'capability:openapi:get-items',
      )!;
      p.capabilities.push({
        ...structuredClone(first),
        id: 'capability:openapi:post-items',
        protocolKey: 'POST /items',
        name: 'createItem',
      });
      p.inventoryGroups.find((g) => g.id === 'inventory:openapi')!.itemCount =
        2;
      p.fingerprints.passport.value = canonicalSha256({
        checked,
        payment: payment ?? null,
      });
      return p;
    };
    const coverage = comparePassports(
      twoOperations(undefined, false),
      twoOperations(summary(), true),
    ).changes.filter(
      (change) =>
        change.code === 'OPENAPI_PAYMENT_DECLARATION_COVERAGE_CHANGED',
    );
    expect(coverage).toHaveLength(1);
  });

  it('emits nothing when only an unchanged declaration is present', () =>
    expect(paymentCodes(operation(summary()), operation(summary()))).toEqual(
      [],
    ));
});

describe('compatibility-rules-v7 WebMCP page-target drift', () => {
  const pagePath = '/checkout';
  const target = (rootHtml: string, pageHtml?: string): AgentPassport => {
    const root = extractWebMcpDeclarativeTools(
      rootHtml,
      new URL(report.origin),
      `${report.origin}/`,
    );
    const submittedPage =
      pageHtml === undefined
        ? undefined
        : extractWebMcpDeclarativeTools(
            pageHtml,
            new URL(`${report.origin}${pagePath}`),
            `${report.origin}${pagePath}`,
            'submitted_page_html_declarative_forms',
          );
    return normalizeDiscoveryReport(
      { ...report, webmcp: { ...root, submittedPage } } as DiscoveryReport,
      { monitoredPage: pagePath },
    );
  };
  const root = '<form toolname="book"><input name="date"></form>';
  const pay = '<form toolname="pay"><input name="card"></form>';
  const refund = '<form toolname="refund"><input name="id"></form>';
  const pairs = (a: AgentPassport, b: AgentPassport) =>
    comparePassports(a, b).changes.map((c) => [c.code, c.classification]);

  it('reports a watched page starting to declare tools as non-breaking', () =>
    expect(pairs(target(root), target(root, pay))).toEqual([
      ['WEBMCP_DECLARATIONS_OBSERVED', 'non_breaking'],
    ]));

  it('never claims removal when a watched page stops showing tools', () => {
    for (const after of [target(root), target(root, '<p>none</p>')]) {
      const changes = pairs(target(root, pay), after);
      expect(changes).toEqual([
        ['WEBMCP_DECLARATIONS_NOT_OBSERVED', 'indeterminate'],
      ]);
    }
  });

  it('applies complete-inventory tool rules per page artifact', () => {
    expect(pairs(target(root, pay + refund), target(root, pay))).toEqual([
      ['CAPABILITY_REMOVED', 'breaking'],
    ]);
    expect(pairs(target(root, pay), target(root, pay + refund))).toEqual([
      ['CAPABILITY_ADDED', 'non_breaking'],
    ]);
  });

  it('keeps the protocol rule for a page-target whose only tools vanish', () =>
    expect(
      pairs(target('<p>none</p>', pay), target('<p>none</p>', '<p>none</p>')),
    ).toEqual([['WEBMCP_DECLARATIONS_NOT_OBSERVED', 'indeterminate']]));
});

describe('compatibility-rules-v8 unread discovery sources', () => {
  const card = {
    id: 'artifact:card',
    kind: 'mcp.server-card.experimental' as const,
    protocol: 'mcp-server-card' as const,
    url: 'https://example.com/.well-known/mcp/server-card.json',
    status: 'valid',
    validationStatus: 'valid' as const,
    provenance: ['discovery:ard'],
  };
  const status = (p: AgentPassport, protocol: string, value: string) => {
    p.protocols.find((x) => x.protocol === protocol)!.status = value;
  };
  // MCP reached through a Server Card the ARD catalog declares, plus OpenAPI.
  const discovered = passport((p) => {
    p.endpoints.push({
      ...structuredClone(endpoint),
      relationship: 'declared_and_inspected',
      declarationSources: ['server_card_declared'],
      artifactRefs: [card.id],
    });
    p.artifacts.push(structuredClone(card));
    for (const protocol of ['ard', 'mcp', 'mcp-server-card', 'openapi'])
      status(p, protocol, 'valid');
    p.inventoryGroups.push(group('mcp.tool'));
    p.capabilities.push(tool('alpha'));
  });
  const after = (ard: string, cardStatus?: string) =>
    passport((p) => {
      status(p, 'ard', ard);
      if (cardStatus) {
        p.artifacts.push({ ...structuredClone(card), status: cardStatus });
        status(p, 'mcp-server-card', 'observed');
      }
    });
  const reasons = (current: AgentPassport) =>
    comparePassports(discovered, current).changes.map((change) => [
      change.code,
      change.entityId,
      change.classification,
      change.reasonCode,
    ]);
  const unproven = 'DISCOVERY_SOURCE_NOT_OBSERVED_REMOVAL_NOT_PROVEN';

  it.each(['unreachable', 'blocked'])(
    'reports no removal when the ARD catalog is %s',
    (ard) => {
      const result = reasons(after(ard));
      expect(result.some(([, , level]) => level === 'breaking')).toBe(false);
      for (const protocol of ['mcp', 'mcp-server-card', 'openapi'])
        expect(result).toContainEqual([
          'PROTOCOL_OBSERVATION_FAILED',
          protocol,
          'indeterminate',
          unproven,
        ]);
      expect(result).toContainEqual([
        'ENDPOINT_OBSERVATION_FAILED',
        endpoint.id,
        'indeterminate',
        unproven,
      ]);
    },
  );
  it.each(['unreachable', 'blocked', 'declared_not_fetched'])(
    'reports no MCP removal when its Server Card is %s',
    (cardStatus) => {
      const result = reasons(after('valid', cardStatus));
      expect(result).toContainEqual([
        'PROTOCOL_OBSERVATION_FAILED',
        'mcp',
        'indeterminate',
        unproven,
      ]);
      expect(result).toContainEqual([
        'ENDPOINT_OBSERVATION_FAILED',
        endpoint.id,
        'indeterminate',
        unproven,
      ]);
      // The catalog answered without OpenAPI: that removal is conclusive.
      expect(result).toContainEqual([
        'OPENAPI_SURFACE_REMOVED',
        'openapi',
        'breaking',
        'PREVIOUSLY_PRESENT_CURRENTLY_CONCLUSIVELY_ABSENT',
      ]);
      expect(
        result.some(
          ([code, id]) =>
            (code === 'PROTOCOL_SURFACE_REMOVED' && id === 'mcp') ||
            code === 'ENDPOINT_REMOVED',
        ),
      ).toBe(false);
    },
  );
  it.each([
    ['not_found', undefined],
    ['invalid', undefined],
    ['valid', 'not_found'],
    ['valid', 'invalid'],
  ])(
    'keeps a publisher answer conclusive (ARD %s, card %s)',
    (ard, cardStatus) => {
      const result = reasons(after(ard, cardStatus));
      expect(result).toContainEqual([
        'PROTOCOL_SURFACE_REMOVED',
        'mcp',
        'breaking',
        'PREVIOUSLY_PRESENT_CURRENTLY_CONCLUSIVELY_ABSENT',
      ]);
      expect(result).toContainEqual([
        'ENDPOINT_REMOVED',
        endpoint.id,
        'breaking',
        'PREVIOUSLY_PRESENT_CURRENTLY_CONCLUSIVELY_ABSENT',
      ]);
      expect(result.some(([, , , reason]) => reason === unproven)).toBe(false);
    },
  );
  it('ignores a Server Card that was not read before either', () => {
    const other = {
      ...structuredClone(card),
      id: 'artifact:card-b',
      url: 'https://cards.example.net/server-card.json',
    };
    // Card B is cross-origin (never fetched) or failing on both sides; the
    // publisher drops /mcp from card A, which still answers.
    for (const status of ['declared_not_fetched', 'unreachable']) {
      const withB = (base: AgentPassport) =>
        passport((p) => {
          Object.assign(p, structuredClone(base));
          p.artifacts.push({ ...structuredClone(other), status });
          for (const item of p.endpoints)
            item.artifactRefs = [card.id, other.id];
        });
      const current = passport((p) => {
        for (const protocol of ['ard', 'mcp-server-card', 'openapi'])
          p.protocols.find((x) => x.protocol === protocol)!.status = 'valid';
        p.artifacts.push(structuredClone(card));
      });
      const result = comparePassports(
        withB(discovered),
        withB(current),
      ).changes.map((change) => [change.code, change.classification]);
      expect(result).toContainEqual(['PROTOCOL_SURFACE_REMOVED', 'breaking']);
      expect(result).toContainEqual(['ENDPOINT_REMOVED', 'breaking']);
    }
  });
  it('treats an endpoint as unproven when any card that named it is unread', () => {
    const other = { ...structuredClone(card), id: 'artifact:card-b' };
    const both = passport((p) => {
      Object.assign(p, structuredClone(discovered));
      p.artifacts.push(structuredClone(other));
      p.endpoints[0]!.artifactRefs = [card.id, other.id];
    });
    const current = passport((p) => {
      for (const protocol of ['ard', 'mcp-server-card', 'openapi'])
        p.protocols.find((x) => x.protocol === protocol)!.status = 'valid';
      p.artifacts.push(structuredClone(card), {
        ...structuredClone(other),
        status: 'unreachable',
      });
    });
    const result = comparePassports(both, current).changes.map((change) => [
      change.code,
      change.classification,
      change.reasonCode,
    ]);
    expect(result).toContainEqual([
      'ENDPOINT_OBSERVATION_FAILED',
      'indeterminate',
      unproven,
    ]);
    expect(result.some(([code]) => code === 'ENDPOINT_REMOVED')).toBe(false);
  });
  it('keeps a supplied endpoint conclusive when the catalog fails', () => {
    const result = codes(
      configured(),
      passport((p) => status(p, 'ard', 'unreachable')),
    );
    expect(result).toContainEqual(['ENDPOINT_REMOVED', 'breaking']);
  });
});
