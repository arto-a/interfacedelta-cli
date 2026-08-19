import { describe, expect, it } from 'vitest';
import type { AgentPassport } from '@interfacedelta/contracts';
import { normalizeDiscoveryReport } from './normalize';
import { canonicalSha256 } from './canonical-json';
import { comparePassports } from './drift';
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
    projectionVersion: 'capability-semantic-v1' as const,
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
  it('treats description-only changes as informational', () =>
    expect(
      codes(configured(), configured([tool('alpha', 'new description')])),
    ).toContainEqual(['CAPABILITY_METADATA_CHANGED', 'informational']));
  it('classifies endpoint removal but not failure as removal', () => {
    const removed=codes(configured(),passport(()=>{}));
    expect(removed).toContainEqual(['ENDPOINT_REMOVED', 'breaking']);
    expect(removed).toContainEqual(['PROTOCOL_SURFACE_REMOVED','breaking']);
    const failed = passport((p) => {
      p.protocols.find((x) => x.protocol === 'mcp')!.status = 'unreachable';
    });
    const result = codes(configured(), failed);
    expect(result).toContainEqual([
      'ENDPOINT_OBSERVATION_FAILED',
      'indeterminate',
    ]);
    expect(result.some(([code]) => code === 'ENDPOINT_REMOVED')).toBe(false);
    expect(result.some(([code]) => code === 'PROTOCOL_SURFACE_REMOVED')).toBe(false);
  });
  it.each([
    ['auth_required', 'ACCESS_NOW_REQUIRES_AUTH', 'breaking'],
    ['forbidden', 'ACCESS_NOW_FORBIDDEN', 'breaking'],
  ] as const)(
    'classifies public to %s access',
    (status, code, classification) => {
      const after = configured();
      after.endpoints[0]!.observationStatus = status;
      after.fingerprints.passport.value = canonicalSha256(after.endpoints);
      expect(codes(configured(), after)).toContainEqual([code, classification]);
    },
  );
  it('classifies access becoming publicly observable as non-breaking', () => {
    const before = configured();
    before.endpoints[0]!.observationStatus = 'auth_required';
    before.fingerprints.passport.value = canonicalSha256(before.endpoints);
    expect(codes(before, configured())).toContainEqual([
      'ACCESS_BECAME_PUBLICLY_OBSERVABLE',
      'non_breaking',
    ]);
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
    before.consistency.findings.push({code:'ARD_DECLARED_MCP_SERVER_CARD',status:'match',subjectRefs:[],evidenceRefs:[],message:'match'});
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
    before.fingerprints.passport.value=canonicalSha256({identity:before.identityAssertions,consistency:before.consistency});
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
  it('is deterministic across equivalent array and object ordering', () => {
    const previous = configured([tool('b'), tool('a')]);
    const current = configured([tool('c')]);
    const reorderedPrevious=structuredClone(previous),reorderedCurrent=structuredClone(current);reorderedPrevious.capabilities.reverse();reorderedPrevious.inventoryGroups.reverse();reorderedCurrent.capabilities.reverse();reorderedCurrent.inventoryGroups.reverse();const first = comparePassports(previous, current),second = comparePassports(reorderedPrevious,reorderedCurrent);
    expect(second.changes).toEqual(first.changes);
    expect(second.changeSetFingerprint).toEqual(first.changeSetFingerprint);
    expect(first.ruleVersion).toBe('compatibility-rules-v1');
  });
  it('stops at incompatible representation versions', () => {
    const prior = { ...base, schemaVersion: '0.1.0' };
    const result = comparePassports(prior, base);
    expect(result.state).toBe('incompatible_version');
    expect(result.changes).toEqual([]);
  });
});
