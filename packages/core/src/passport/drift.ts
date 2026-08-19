import { z } from 'zod';
import { passportSchema, type AgentPassport } from '@interfacedelta/contracts';
import { canonicalSha256 } from './canonical-json';

export const COMPARISON_RULE_VERSION = 'compatibility-rules-v1' as const;
export const CHANGE_SET_PROJECTION_VERSION = 'passport-change-set-v1' as const;
export const comparisonStateSchema = z.enum([
  'baseline',
  'unchanged',
  'changed',
  'incompatible_version',
]);
export const changeClassificationSchema = z.enum([
  'breaking',
  'non_breaking',
  'informational',
  'indeterminate',
]);
export type ChangeClassification = z.infer<typeof changeClassificationSchema>;
export type ComparisonState = z.infer<typeof comparisonStateSchema>;

export const changeEventSchema = z.object({
  semanticId: z.string(),
  code: z.string(),
  classification: changeClassificationSchema,
  entityKind: z.string(),
  entityId: z.string(),
  path: z.string(),
  reasonCode: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
});
export type ChangeEvent = z.infer<typeof changeEventSchema>;
export type ChangeCounts = {
  breaking: number;
  nonBreaking: number;
  informational: number;
  indeterminate: number;
};
export type PassportComparison = {
  state: ComparisonState;
  ruleVersion: typeof COMPARISON_RULE_VERSION;
  previousFingerprint: string | null;
  currentFingerprint: string;
  changes: ChangeEvent[];
  counts: ChangeCounts;
  highestClassification: ChangeClassification | 'none';
  changeSetFingerprint: {
    algorithm: 'sha256';
    canonicalization: 'RFC8785';
    projectionVersion: typeof CHANGE_SET_PROJECTION_VERSION;
    value: string;
  };
};

const rank: Record<ChangeClassification, number> = {
  breaking: 0,
  indeterminate: 1,
  non_breaking: 2,
  informational: 3,
};
const bounded = (value: unknown): unknown =>
  value === undefined ? null : value;
function event(
  code: string,
  classification: ChangeClassification,
  entityKind: string,
  entityId: string,
  path: string,
  reasonCode: string,
  before: unknown = null,
  after: unknown = null,
): ChangeEvent {
  const core = {
    code,
    classification,
    entityKind,
    entityId,
    path,
    reasonCode,
    before: bounded(before),
    after: bounded(after),
  };
  return {
    ...core,
    semanticId: `change:${canonicalSha256(core).slice(0, 24)}`,
  };
}
function ordered(changes: ChangeEvent[]): ChangeEvent[] {
  return changes.sort(
    (a, b) =>
      rank[a.classification] - rank[b.classification] ||
      a.entityKind.localeCompare(b.entityKind) ||
      a.entityId.localeCompare(b.entityId) ||
      a.code.localeCompare(b.code) ||
      a.path.localeCompare(b.path) ||
      a.semanticId.localeCompare(b.semanticId),
  );
}
function finish(
  state: ComparisonState,
  previous: { fingerprints: { passport: { value: string } } } | null,
  current: AgentPassport,
  changes: ChangeEvent[],
): PassportComparison {
  const normalized = ordered(changes);
  const counts = {
    breaking: 0,
    nonBreaking: 0,
    informational: 0,
    indeterminate: 0,
  };
  for (const item of normalized) {
    if (item.classification === 'non_breaking') counts.nonBreaking++;
    else counts[item.classification]++;
  }
  const highest = normalized[0]?.classification ?? 'none';
  const projection = {
    ruleVersion: COMPARISON_RULE_VERSION,
    state,
    previousFingerprint: previous?.fingerprints.passport.value ?? null,
    currentFingerprint: current.fingerprints.passport.value,
    changes: normalized,
  };
  return {
    state,
    ruleVersion: COMPARISON_RULE_VERSION,
    previousFingerprint: projection.previousFingerprint,
    currentFingerprint: projection.currentFingerprint,
    changes: normalized,
    counts,
    highestClassification: highest,
    changeSetFingerprint: {
      algorithm: 'sha256',
      canonicalization: 'RFC8785',
      projectionVersion: CHANGE_SET_PROJECTION_VERSION,
      value: canonicalSha256(projection),
    },
  };
}
const mapById = <T extends { id: string }>(items: readonly T[]) =>
  new Map(items.map((item) => [item.id, item]));
const display = (item: AgentPassport['capabilities'][number]) => ({
  name: item.name,
  title: item.title ?? null,
  description: item.description ?? null,
  metadata: item.metadata,
});
const inventoryKey = (item: AgentPassport['capabilities'][number]) =>
  `${item.sourceRef}|${item.kind}`;
function inventoryCompleteness(passport: AgentPassport): Map<string, boolean> {
  return new Map(
    passport.inventoryGroups.map((group) => [
      `${group.sourceRef}|${group.kind}`,
      group.attempted && group.complete,
    ]),
  );
}
const failureStatuses = new Set(['unreachable', 'blocked']);
const conclusiveAbsent = (status: string) =>
  ['not_found', 'invalid', 'not_detected', 'not_mcp'].includes(status);

export function comparePassports(
  previousInput: unknown,
  currentInput: AgentPassport,
): PassportComparison {
  const current = passportSchema.parse(currentInput);
  const prior = previousInput as {
    schemaVersion?: unknown;
    fingerprints?: {
      passport?: { projectionVersion?: unknown; value?: unknown };
    };
  };
  if (
    prior.schemaVersion !== current.schemaVersion ||
    prior.fingerprints?.passport?.projectionVersion !==
      current.fingerprints.passport.projectionVersion
  ) {
    const previousFingerprint =
      typeof prior.fingerprints?.passport?.value === 'string'
        ? prior.fingerprints.passport.value
        : 'unknown';
    return finish(
      'incompatible_version',
      { fingerprints: { passport: { value: previousFingerprint } } },
      current,
      [],
    );
  }
  const previous = passportSchema.parse(previousInput);
  if (
    previous.fingerprints.passport.value === current.fingerprints.passport.value
  )
    return finish('unchanged', previous, current, []);
  const changes: ChangeEvent[] = [];
  const previousCapabilities = mapById(previous.capabilities),
    currentCapabilities = mapById(current.capabilities),
    pc = inventoryCompleteness(previous),
    cc = inventoryCompleteness(current);
  const incompleteGroups = new Set<string>();
  for (const group of [
    ...previous.inventoryGroups,
    ...current.inventoryGroups,
  ]) {
    const key = `${group.sourceRef}|${group.kind}`;
    if (pc.get(key) !== true || cc.get(key) !== true) incompleteGroups.add(key);
  }
  for (const key of [...incompleteGroups].sort())
    changes.push(
      event(
        'INVENTORY_COMPARISON_INDETERMINATE',
        'indeterminate',
        'inventory',
        key,
        'capabilities',
        'INVENTORY_INCOMPLETE_ON_ONE_OR_BOTH_SIDES',
        { complete: pc.get(key) ?? false },
        { complete: cc.get(key) ?? false },
      ),
    );
  for (const [id, item] of previousCapabilities) {
    if (currentCapabilities.has(id)) continue;
    if (incompleteGroups.has(inventoryKey(item))) continue;
    changes.push(
      event(
        'CAPABILITY_REMOVED',
        'breaking',
        'capability',
        id,
        'capabilities',
        'PREVIOUSLY_PRESENT_CURRENTLY_ABSENT_COMPLETE_INVENTORIES',
        { kind: item.kind, protocolKey: item.protocolKey },
        null,
      ),
    );
  }
  for (const [id, item] of currentCapabilities) {
    if (previousCapabilities.has(id)) continue;
    if (incompleteGroups.has(inventoryKey(item))) continue;
    changes.push(
      event(
        'CAPABILITY_ADDED',
        'non_breaking',
        'capability',
        id,
        'capabilities',
        'CURRENTLY_PRESENT_PREVIOUSLY_ABSENT_COMPLETE_INVENTORIES',
        null,
        { kind: item.kind, protocolKey: item.protocolKey },
      ),
    );
  }
  for (const [id, before] of previousCapabilities) {
    const after = currentCapabilities.get(id);
    if (!after) continue;
    if (before.kind === 'mcp.tool' && after.kind === 'mcp.tool')
      for (const [field, code] of [
        ['inputSchemaSha256', 'MCP_TOOL_INPUT_SCHEMA_CHANGED'],
        ['outputSchemaSha256', 'MCP_TOOL_OUTPUT_SCHEMA_CHANGED'],
      ] as const) {
        const a = before.metadata[field],
          b = after.metadata[field];
        if (a !== b)
          changes.push(
            event(
              code,
              'indeterminate',
              'capability',
              id,
              `capabilities.${field}`,
              'SCHEMA_HASH_INEQUALITY_DOES_NOT_PROVE_COMPATIBILITY',
              a,
              b,
            ),
          );
      }
    const bd = display(before),
      ad = display(after);
    if (canonicalSha256(bd) !== canonicalSha256(ad)) {
      const contractKeys = new Set(['inputSchemaSha256', 'outputSchemaSha256']);
      const strip = (v: typeof bd) => ({
        name: v.name,
        title: v.title,
        description: v.description,
        metadata: Object.fromEntries(
          Object.entries(v.metadata).filter(([k]) => !contractKeys.has(k)),
        ),
      });
      if (canonicalSha256(strip(bd)) !== canonicalSha256(strip(ad)))
        changes.push(
          event(
            'CAPABILITY_METADATA_CHANGED',
            'informational',
            'capability',
            id,
            'capabilities.metadata',
            'DISPLAY_OR_NON_CONTRACT_METADATA_CHANGED',
            strip(bd),
            strip(ad),
          ),
        );
    }
  }
  const pe = mapById(previous.endpoints),
    ce = mapById(current.endpoints);
  for (const [id, before] of pe) {
    const after = ce.get(id);
    if (!after) {
      if (
        failureStatuses.has(
          current.protocols.find((p) => p.protocol === before.protocol)
            ?.status ?? '',
        )
      )
        changes.push(
          event(
            'ENDPOINT_OBSERVATION_FAILED',
            'indeterminate',
            'endpoint',
            id,
            'endpoints',
            'CURRENT_PROTOCOL_OBSERVATION_FAILED',
            { url: before.url },
            null,
          ),
        );
      else
        changes.push(
          event(
            'ENDPOINT_REMOVED',
            'breaking',
            'endpoint',
            id,
            'endpoints',
            'PREVIOUSLY_PRESENT_CURRENTLY_CONCLUSIVELY_ABSENT',
            { url: before.url },
            null,
          ),
        );
      continue;
    }
    if (before.protocolVersion !== after.protocolVersion)
      changes.push(
        event(
          'PROTOCOL_VERSION_CHANGED',
          'indeterminate',
          'endpoint',
          id,
          'endpoints.protocolVersion',
          'VERSION_CHANGE_COMPATIBILITY_NOT_INFERRED',
          before.protocolVersion,
          after.protocolVersion,
        ),
      );
    const wasPublic = ['valid', 'truncated'].includes(before.observationStatus),
      nowPublic = ['valid', 'truncated'].includes(after.observationStatus);
    if (wasPublic && after.observationStatus === 'auth_required')
      changes.push(
        event(
          'ACCESS_NOW_REQUIRES_AUTH',
          'breaking',
          'endpoint',
          id,
          'endpoints.observationStatus',
          'PUBLIC_OBSERVATION_NOW_AUTH_REQUIRED',
          before.observationStatus,
          after.observationStatus,
        ),
      );
    else if (wasPublic && after.observationStatus === 'forbidden')
      changes.push(
        event(
          'ACCESS_NOW_FORBIDDEN',
          'breaking',
          'endpoint',
          id,
          'endpoints.observationStatus',
          'PUBLIC_OBSERVATION_NOW_FORBIDDEN',
          before.observationStatus,
          after.observationStatus,
        ),
      );
    else if (
      ['auth_required', 'forbidden'].includes(before.observationStatus) &&
      nowPublic
    )
      changes.push(
        event(
          'ACCESS_BECAME_PUBLICLY_OBSERVABLE',
          'non_breaking',
          'endpoint',
          id,
          'endpoints.observationStatus',
          'UNAUTHENTICATED_OBSERVATION_NOW_SUCCEEDS',
          before.observationStatus,
          after.observationStatus,
        ),
      );
    else if (before.observationStatus !== after.observationStatus)
      changes.push(
        event(
          'ENDPOINT_OBSERVATION_STATE_CHANGED',
          'indeterminate',
          'endpoint',
          id,
          'endpoints.observationStatus',
          'OBSERVATION_STATE_CHANGE_NOT_INTERFACE_REMOVAL',
          before.observationStatus,
          after.observationStatus,
        ),
      );
  }
  for (const [id, after] of ce)
    if (!pe.has(id))
      changes.push(
        failureStatuses.has(after.observationStatus)
          ? event('ENDPOINT_OBSERVATION_FAILED','indeterminate','endpoint',id,'endpoints','NEW_ENDPOINT_COULD_NOT_BE_OBSERVED',null,{url:after.url,status:after.observationStatus})
          : event('ENDPOINT_ADDED','non_breaking','endpoint',id,'endpoints','CURRENTLY_PRESENT_PREVIOUSLY_ABSENT',null,{url:after.url}),
      );
  if(canonicalSha256(previous.accessAssertions)!==canonicalSha256(current.accessAssertions))changes.push(event('ACCESS_METADATA_CHANGED','indeterminate','access','assertions','accessAssertions','DECLARED_OR_OBSERVED_ACCESS_METADATA_CHANGED',{count:previous.accessAssertions.length,sha256:canonicalSha256(previous.accessAssertions)},{count:current.accessAssertions.length,sha256:canonicalSha256(current.accessAssertions)}));
  const pp = new Map(previous.protocols.map((p) => [p.protocol, p])),
    cp = new Map(current.protocols.map((p) => [p.protocol, p]));
  for (const [id, before] of pp) {
    const after = cp.get(id)!;
    const wasPresent = ['valid', 'observed'].includes(before.status),
      isPresent = ['valid', 'observed'].includes(after.status);
    if (wasPresent && !isPresent) {
      if (failureStatuses.has(after.status))
        changes.push(
          event(
            'PROTOCOL_OBSERVATION_FAILED',
            'indeterminate',
            'protocol',
            id,
            'protocols.status',
            'NETWORK_OR_POLICY_FAILURE_DOES_NOT_PROVE_REMOVAL',
            before.status,
            after.status,
          ),
        );
      else if (conclusiveAbsent(after.status))
        changes.push(
          event(
            'PROTOCOL_SURFACE_REMOVED',
            'breaking',
            'protocol',
            id,
            'protocols.status',
            'PREVIOUSLY_PRESENT_CURRENTLY_CONCLUSIVELY_ABSENT',
            before.status,
            after.status,
          ),
        );
    } else if (!wasPresent && isPresent)
      changes.push(
        event(
          'PROTOCOL_SURFACE_ADDED',
          'non_breaking',
          'protocol',
          id,
          'protocols.status',
          'CURRENTLY_PRESENT_PREVIOUSLY_ABSENT',
          before.status,
          after.status,
        ),
      );
    if (before.revision !== after.revision)
      changes.push(
        event(
          'PROTOCOL_VERSION_CHANGED',
          'indeterminate',
          'protocol',
          id,
          'protocols.revision',
          'VERSION_CHANGE_COMPATIBILITY_NOT_INFERRED',
          before.revision,
          after.revision,
        ),
      );
  }
  const pi = mapById(previous.identityAssertions),
    ci = mapById(current.identityAssertions);
  if (canonicalSha256([...pi.values()]) !== canonicalSha256([...ci.values()]))
    changes.push(
      event(
        'IDENTITY_ASSERTION_CHANGED',
        'informational',
        'identity',
        'self-reported',
        'identityAssertions',
        'SELF_REPORTED_IDENTITY_CHANGED',
        {count:previous.identityAssertions.length,sha256:canonicalSha256(previous.identityAssertions)},
        {count:current.identityAssertions.length,sha256:canonicalSha256(current.identityAssertions)},
      ),
    );
  const pf = new Map(previous.consistency.findings.map((f) => [f.code, f])),
    cf = new Map(current.consistency.findings.map((f) => [f.code, f]));
  for (const code of [...new Set([...pf.keys(), ...cf.keys()])].sort()) {
    const a = pf.get(code),
      b = cf.get(code);
    if (a?.status !== b?.status)
      changes.push(
        event(
          'CONSISTENCY_FINDING_CHANGED',
          'informational',
          'consistency',
          code,
          'consistency.findings',
          'CONSISTENCY_RESULT_CHANGED',
          a?.status,
          b?.status,
        ),
      );
  }
  if (changes.length === 0)
    changes.push(
      event(
        'UNCLASSIFIED_SEMANTIC_CHANGE',
        'indeterminate',
        'passport',
        'semantic-projection',
        'fingerprints.passport',
        'FINGERPRINT_CHANGED_WITHOUT_A_SPECIFIC_IMPLEMENTED_RULE',
        previous.fingerprints.passport.value,
        current.fingerprints.passport.value,
      ),
    );
  return finish('changed', previous, current, changes);
}

export function baselineComparison(
  currentInput: AgentPassport,
): PassportComparison {
  return finish('baseline', null, passportSchema.parse(currentInput), []);
}
