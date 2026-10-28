import { z } from 'zod-v3';
import { passportSchema, type AgentPassport } from '@interfacedelta/contracts';
import { analyzeSchemaCompatibility } from '@interfacedelta/schema-compatibility';
import { canonicalSha256 } from './canonical-json';
import {
  computePassportFingerprint,
  passportSemanticProjection,
} from './normalize';

export const COMPARISON_RULE_VERSION = 'compatibility-rules-v8' as const;
export const HOSTED_COMPARISON_RULE_VERSION = 'compatibility-rules-v9' as const;
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
  recovery?: ComparisonRecovery;
  state: ComparisonState;
  ruleVersion: string;
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
      a.entityKind.localeCompare(b.entityKind, 'en') ||
      a.entityId.localeCompare(b.entityId, 'en') ||
      a.code.localeCompare(b.code, 'en') ||
      a.path.localeCompare(b.path, 'en') ||
      a.semanticId.localeCompare(b.semanticId, 'en'),
  );
}
function finish(
  state: ComparisonState,
  previous: { fingerprints: { passport: { value: string } } } | null,
  current: AgentPassport,
  changes: ChangeEvent[],
  recovery?: ComparisonRecovery,
  ruleVersion: string = COMPARISON_RULE_VERSION,
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
    ruleVersion,
    state,
    previousFingerprint: previous?.fingerprints.passport.value ?? null,
    currentFingerprint: current.fingerprints.passport.value,
    changes: normalized,
    ...(recovery ? { recovery } : {}),
  };
  return {
    ...(recovery ? { recovery } : {}),
    state,
    ruleVersion,
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
type PaymentSummary = {
  offers?: { intent?: string; method?: string }[];
  offersTruncated?: boolean;
  declares402Response?: boolean;
};
const paymentChecked = (item: AgentPassport['capabilities'][number]) =>
  Object.hasOwn(item.metadata, 'paymentDeclaration');
const paymentSummary = (
  item: AgentPassport['capabilities'][number],
): PaymentSummary | undefined => {
  const value = item.metadata.paymentDeclaration;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PaymentSummary)
    : undefined;
};
// A requirement is only conclusive when at least one offer names both an intent and a method.
const usableOffer = (summary: PaymentSummary | undefined) =>
  Boolean(summary?.offers?.some((offer) => offer.intent && offer.method));

function paymentDeclarationChanges(
  id: string,
  before: AgentPassport['capabilities'][number],
  after: AgentPassport['capabilities'][number],
  groupComplete: boolean,
): ChangeEvent[] {
  const a = paymentSummary(before),
    b = paymentSummary(after);
  if (canonicalSha256(a ?? null) === canonicalSha256(b ?? null)) return [];
  const conclusive =
    groupComplete &&
    before.inventory.complete &&
    after.inventory.complete &&
    !a?.offersTruncated &&
    !b?.offersTruncated;
  const path = 'capabilities.metadata.paymentDeclaration';
  // The spec's payable operation needs both the extension and a declared 402 response.
  if (conclusive && !a && usableOffer(b) && b?.declares402Response === true)
    return [
      event(
        'OPENAPI_OPERATION_NOW_REQUIRES_PAYMENT',
        'breaking',
        'capability',
        id,
        path,
        'PUBLISHER_NOW_DECLARES_PAYMENT_REQUIREMENT',
        null,
        b,
      ),
    ];
  if (conclusive && usableOffer(a) && !b)
    return [
      event(
        'OPENAPI_OPERATION_NO_LONGER_REQUIRES_PAYMENT',
        'non_breaking',
        'capability',
        id,
        path,
        'PUBLISHER_NO_LONGER_DECLARES_PAYMENT_REQUIREMENT',
        a,
        null,
      ),
    ];
  return [
    event(
      'OPENAPI_PAYMENT_DECLARATION_CHANGED',
      'indeterminate',
      'capability',
      id,
      path,
      !conclusive
        ? 'PAYMENT_EVIDENCE_INCOMPLETE'
        : !a && usableOffer(b) && b?.declares402Response !== true
          ? 'PAYMENT_DECLARED_WITHOUT_402_RESPONSE'
          : 'PAYMENT_DECLARATION_CHANGED_COMPATIBILITY_NOT_INFERRED',
      a ?? null,
      b ?? null,
    ),
  ];
}

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
const sourceFailureStatuses = new Set([
  ...failureStatuses,
  'declared_not_fetched',
]);
/**
 * Rules v8: MCP, its Server Cards and OpenAPI are discovered through the ARD
 * catalog, and MCP endpoints through Server Cards. When the observer could not
 * read that source this time, an absent surface was never looked for, so its
 * absence is not a removal. A publisher's answer (404, invalid) is still
 * conclusive. A Server Card counts only if it was read before (`valid`) and
 * not now: a card that is never fetched (cross-origin, refused URL) supplied
 * nothing on either side. `cardRefs` limits the cards to those that named the
 * missing endpoints; an empty list means a supplied endpoint.
 */
function discoverySourceUnobserved(
  previous: AgentPassport,
  current: AgentPassport,
  protocol: string,
  cardRefs?: readonly string[],
) {
  if (
    !['mcp', 'mcp-server-card', 'openapi'].includes(protocol) ||
    cardRefs?.length === 0
  )
    return false;
  const ard = current.protocols.find((item) => item.protocol === 'ard');
  if (failureStatuses.has(ard?.status ?? '')) return true;
  if (protocol !== 'mcp') return false;
  const before = new Map(
    previous.artifacts.map((item) => [item.id, item.status]),
  );
  return current.artifacts.some(
    (item) =>
      item.protocol === 'mcp-server-card' &&
      (!cardRefs || cardRefs.includes(item.id)) &&
      before.get(item.id) === 'valid' &&
      sourceFailureStatuses.has(item.status),
  );
}

export const RECOVERY_OBSERVATION_LIMIT = 30;
export type RecoveryObservation = { id: string; passport: unknown };
type RecoverySource = {
  kind: 'protocol' | 'server-card' | 'endpoint' | 'artifact';
  id: string;
};
export const comparisonRecoverySchema = z.object({
  version: z.literal('per-source-recovery-v1'),
  window: z.literal(RECOVERY_OBSERVATION_LIMIT),
  previousObservationId: z.string().min(1),
  previousFingerprint: z.string().min(1),
  sources: z.array(
    z.object({
      source: z.object({
        kind: z.enum(['protocol', 'server-card', 'endpoint', 'artifact']),
        id: z.string().min(1),
      }),
      baseObservationId: z.string().min(1).nullable(),
      surfaces: z.array(
        z.object({
          entityKind: z.enum([
            'protocol',
            'endpoint',
            'inventory',
            'capability',
            'artifact',
            'identity',
            'access',
            'consistency',
          ]),
          entityId: z.string().min(1),
          baseObservationId: z.string().min(1),
        }),
      ),
    }),
  ),
});
export type ComparisonRecovery = z.infer<typeof comparisonRecoverySchema>;

const protocolStatus = (p: AgentPassport, id: string) =>
  p.protocols.find((item) => item.protocol === id)?.status ?? '';
const artifactStatus = (p: AgentPassport, id: string) =>
  p.artifacts.find((item) => item.id === id)?.status;
function sourceRead(
  p: AgentPassport,
  source: RecoverySource,
  reference: AgentPassport = p,
): boolean {
  if (source.kind === 'endpoint') {
    const endpoint = p.endpoints.find((e) => e.id === source.id);
    if (endpoint) return !failureStatuses.has(endpoint.observationStatus);
    const before = reference.endpoints.find((e) => e.id === source.id);
    return (
      !!before &&
      !discoverySourceUnobserved(
        reference,
        p,
        before.protocol,
        before.artifactRefs,
      )
    );
  }
  if (source.kind === 'protocol') {
    const status = protocolStatus(p, source.id);
    if (failureStatuses.has(status)) return false;
    if (status !== 'not_detected') return true;
    const endpoints = reference.endpoints.filter(
      (item) => item.protocol === 'mcp',
    );
    // No retained endpoint means unknown provenance, not a supplied endpoint.
    // An actual supplied endpoint retains v8's empty-reference exemption.
    const refs =
      source.id === 'mcp' && endpoints.length
        ? endpoints.flatMap((item) => item.artifactRefs)
        : undefined;
    return !discoverySourceUnobserved(reference, p, source.id, refs);
  }
  const status = artifactStatus(p, source.id);
  const artifact = reference.artifacts.find((a) => a.id === source.id);
  return status === undefined
    ? !!artifact &&
        !discoverySourceUnobserved(
          reference,
          p,
          artifact.protocol,
          artifact.provenance,
        )
    : !sourceFailureStatuses.has(status);
}

/** Recovery detection needs no history query; another unread source never blocks it. */
export function recoveredDiscoverySources(
  previousInput: unknown,
  current: AgentPassport,
): RecoverySource[] {
  const candidate = previousInput as Partial<AgentPassport> | null;
  if (
    !candidate ||
    !(
      (Array.isArray(candidate.protocols) &&
        candidate.protocols.some((p) => p && failureStatuses.has(p.status))) ||
      (Array.isArray(candidate.endpoints) &&
        candidate.endpoints.some(
          (e) => e && failureStatuses.has(e.observationStatus),
        )) ||
      (Array.isArray(candidate.artifacts) &&
        candidate.artifacts.some(
          (a) => a && sourceFailureStatuses.has(a.status),
        ))
    )
  )
    return [];
  const parsed = passportSchema.safeParse(previousInput);
  if (!parsed.success) return [];
  const previous = parsed.data;
  if (!sameRepresentation(previous, current)) return [];
  const sources: RecoverySource[] = [
    ...previous.protocols
      .filter(
        (item) =>
          !sourceRead(
            previous,
            { kind: 'protocol', id: item.protocol },
            current,
          ),
      )
      .map((item) => ({ kind: 'protocol' as const, id: item.protocol })),
    ...previous.endpoints
      .filter((item) => failureStatuses.has(item.observationStatus))
      .map((item) => ({ kind: 'endpoint' as const, id: item.id })),
    ...previous.artifacts
      .filter((item) => sourceFailureStatuses.has(item.status))
      .map((item) => ({
        kind:
          item.protocol === 'mcp-server-card'
            ? ('server-card' as const)
            : ('artifact' as const),
        id: item.id,
      })),
  ];
  return sources.filter((source) => sourceRead(current, source, previous));
}
function sameRepresentation(a: AgentPassport, b: AgentPassport) {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.fingerprints.passport.projectionVersion ===
      b.fingerprints.passport.projectionVersion
  );
}

/** Entity dependencies determine conclusive states and recovery provenance. */
const recoveryCollections = {
  protocols: 'protocol',
  endpoints: 'endpoint',
  artifacts: 'artifact',
  inventoryGroups: 'inventory',
  capabilities: 'capability',
  identityAssertions: 'identity',
  accessAssertions: 'access',
  findings: 'consistency',
} as const;
type RecoveryCollection = keyof typeof recoveryCollections;
type RecoveryEntity =
  | AgentPassport[Exclude<RecoveryCollection, 'findings'>][number]
  | AgentPassport['consistency']['findings'][number];
const recoveryItems = (
  p: AgentPassport,
  collection: RecoveryCollection,
): RecoveryEntity[] =>
  collection === 'findings' ? p.consistency.findings : p[collection];
function setRecoveryItems(
  p: AgentPassport,
  collection: RecoveryCollection,
  items: RecoveryEntity[],
) {
  if (collection === 'findings')
    Object.assign(p.consistency, { findings: items });
  else Object.assign(p, { [collection]: items });
}
type RecoveryNode = {
  key: string;
  kind: (typeof recoveryCollections)[RecoveryCollection];
  id: string;
  collection: RecoveryCollection;
  versions: Map<AgentPassport, RecoveryEntity>;
  dependencies: Set<string>;
};
// Codes identify checks, while subjects identify the independently observed slot.
// Cross-protocol evidence includes publisher IDs and schema-slot labels; retain
// it all so a shared slot label cannot collapse two distinct mappings.
function consistencyInstanceId(
  f: Pick<
    AgentPassport['consistency']['findings'][number],
    'code' | 'subjectRefs' | 'evidenceRefs'
  >,
) {
  return `${f.code}|${JSON.stringify(f.subjectRefs)}|${f.code.startsWith('OPENAPI_MCP_') ? JSON.stringify(f.evidenceRefs) : f.code.startsWith('MCP_SERVER_CARD_REMOTE_') ? JSON.stringify(f.evidenceRefs.slice(0, 1)) : ''}`;
}
function recoveryEntityId(
  collection: RecoveryCollection,
  item: RecoveryEntity,
) {
  if (collection === 'findings')
    return consistencyInstanceId(
      item as AgentPassport['consistency']['findings'][number],
    );
  if (collection === 'protocols')
    return (item as AgentPassport['protocols'][number]).protocol;
  if (collection === 'inventoryGroups') {
    const group = item as AgentPassport['inventoryGroups'][number];
    return `${group.sourceRef}|${group.kind}`;
  }
  return (item as { id: string }).id;
}
function recoveryGraph(passports: AgentPassport[]) {
  const mappingSources = new Map<string, Set<string>>();
  for (const p of passports)
    for (const capability of p.capabilities) {
      const metadata = capability.metadata as {
        explicitCapabilityId?: string;
        explicitCapability?: { id?: string };
      };
      const id =
        metadata.explicitCapabilityId ?? metadata.explicitCapability?.id;
      if (!id) continue;
      const sources = mappingSources.get(id) ?? new Set<string>();
      sources.add(capability.sourceRef);
      mappingSources.set(id, sources);
    }
  const findingMappingId = (
    finding: AgentPassport['consistency']['findings'][number],
  ) => finding.evidenceRefs.find((ref) => mappingSources.has(ref));
  const nodes = new Map<string, RecoveryNode>();
  const byRef = new Map<string, Set<string>>();
  for (const p of passports)
    for (const collection of Object.keys(
      recoveryCollections,
    ) as RecoveryCollection[])
      for (const item of recoveryItems(p, collection)) {
        const kind = recoveryCollections[collection];
        const id = recoveryEntityId(collection, item);
        const key = `${kind}:${id}`;
        let node = nodes.get(key);
        if (!node) {
          node = {
            key,
            kind,
            id,
            collection,
            versions: new Map(),
            dependencies: new Set(),
          };
          nodes.set(key, node);
        }
        node.versions.set(p, item);
        if ('id' in item) {
          const refs = byRef.get(item.id) ?? new Set<string>();
          refs.add(key);
          byRef.set(item.id, refs);
        }
      }
  for (const node of nodes.values())
    for (const item of node.versions.values()) {
      // Cross-interface checks name publisher mappings and protocol keys, not
      // artifact/endpoint IDs. Resolve their supplying instances explicitly;
      // the no-mapping finding depends on the entire observed source inventory.
      if ('subjectRefs' in item && item.code.startsWith('OPENAPI_MCP_')) {
        node.dependencies.add('protocol:mcp');
        node.dependencies.add('protocol:openapi');
        if (!item.evidenceRefs.length) {
          for (const supplier of nodes.values())
            if (
              [...supplier.versions.values()].some(
                (value) =>
                  'protocol' in value &&
                  ((supplier.kind === 'endpoint' && value.protocol === 'mcp') ||
                    (supplier.kind === 'artifact' &&
                      value.protocol === 'openapi')),
              )
            )
              node.dependencies.add(supplier.key);
        } else
          for (const ref of item.evidenceRefs)
            for (const source of mappingSources.get(ref) ?? [])
              for (const dependency of byRef.get(source) ?? [])
                node.dependencies.add(dependency);
      }
      // Protocol rows are summaries, not dependencies of every member on every
      // other member. Their own discovery absence uses the existing v8 rule.
      if (node.kind === 'protocol') {
        node.dependencies.add(`source:protocol:${node.id}`);
        continue;
      }
      if ('protocol' in item)
        node.dependencies.add(`source:protocol:${item.protocol}`);
      if ('protocolKey' in item)
        node.dependencies.add(`inventory:${item.sourceRef}|${item.kind}`);
      const refs = [
        ...('sourceRef' in item ? [item.sourceRef] : []),
        ...('sourceEndpointId' in item && item.sourceEndpointId
          ? [item.sourceEndpointId]
          : []),
        ...('endpointId' in item && item.endpointId ? [item.endpointId] : []),
        ...('artifactRefs' in item ? item.artifactRefs : []),
        ...('provenance' in item ? item.provenance : []),
        ...('subjectRefs' in item ? item.subjectRefs : []),
        ...('evidenceRefs' in item ? item.evidenceRefs : []),
      ];
      for (const ref of refs) {
        for (const dependency of byRef.get(ref) ?? [])
          node.dependencies.add(dependency);
        if (
          ref.startsWith('discovery:') &&
          ['ard', 'a2a'].includes(ref.slice(10))
        )
          node.dependencies.add(`source:protocol:${ref.slice(10)}`);
      }
      if ('declarationSources' in item) {
        if (item.declarationSources.includes('ard_declared'))
          node.dependencies.add('source:protocol:ard');
        if (item.declarationSources.includes('a2a_agent_card'))
          node.dependencies.add('source:protocol:a2a');
      }
    }
  // Preserve v8 discovery provenance for protocol summaries, including old
  // observations without artifactRefs. Supplied MCP endpoints remain exempt.
  for (const node of nodes.values()) {
    if (node.kind !== 'protocol') continue;
    const endpoints = [...nodes.values()].filter(
      (n) =>
        n.kind === 'endpoint' &&
        [...n.versions.values()].some(
          (v) => 'protocol' in v && v.protocol === node.id,
        ),
    );
    if (
      ['mcp', 'mcp-server-card', 'openapi'].includes(node.id) &&
      (node.id !== 'mcp' ||
        !endpoints.length ||
        endpoints.some((e) =>
          [...e.versions.values()].some(
            (v) => 'artifactRefs' in v && v.artifactRefs.length,
          ),
        ))
    )
      node.dependencies.add('source:protocol:ard');
    if (node.id === 'mcp')
      for (const endpoint of endpoints)
        for (const dep of endpoint.dependencies)
          if (nodes.get(dep)?.kind === 'artifact') node.dependencies.add(dep);
  }
  const reaches = (
    node: RecoveryNode,
    root: string,
    seen = new Set<string>(),
  ): boolean => {
    if (node.key === root) return true;
    if (seen.has(node.key)) return false;
    seen.add(node.key);
    return [...node.dependencies].some(
      (dep) =>
        dep === root ||
        (nodes.has(dep) && reaches(nodes.get(dep)!, root, seen)),
    );
  };
  const dependencyUnread = (
    dep: string,
    p: AgentPassport,
    seen: Set<string>,
  ): boolean =>
    dep.startsWith('source:protocol:')
      ? failureStatuses.has(
          protocolStatus(p, dep.slice('source:protocol:'.length)),
        )
      : nodes.has(dep) && unread(nodes.get(dep)!, p, seen);
  const evaluateUnread = (
    node: RecoveryNode,
    p: AgentPassport,
    seen = new Set<string>(),
  ): boolean => {
    if (seen.has(node.key)) return false;
    seen.add(node.key);
    const value = node.versions.get(p);
    if (node.kind === 'protocol') {
      return !sourceRead(
        p,
        { kind: 'protocol', id: node.id },
        {
          ...passports.at(-1)!,
          endpoints: [...nodes.values()]
            .filter((n) => n.kind === 'endpoint')
            .flatMap((n) =>
              [...n.versions.values()].filter(
                (v): v is AgentPassport['endpoints'][number] =>
                  'artifactRefs' in v && 'url' in v && 'observationStatus' in v,
              ),
            ),
        },
      );
    }
    if (value) {
      if (node.kind === 'inventory')
        return [...node.dependencies].some((dep) =>
          dependencyUnread(dep, p, seen),
        );
      if ('observationStatus' in value)
        return failureStatuses.has(value.observationStatus);
      if ('status' in value && node.kind !== 'consistency')
        return sourceFailureStatuses.has(value.status);
      if (
        node.kind === 'consistency' &&
        'subjectRefs' in value &&
        (value.status === 'indeterminate' || value.subjectRefs.length === 0)
      )
        return [...node.dependencies].some((dep) =>
          dependencyUnread(dep, p, seen),
        );
      return false;
    }
    // Preserve v8's missing-endpoint rule: a read card does not make an
    // ARD-dependent absence conclusive while the catalog remains unread.
    const endpoint =
      node.kind === 'endpoint' ? [...node.versions.values()][0] : undefined;
    if (
      endpoint &&
      'observationStatus' in endpoint &&
      discoverySourceUnobserved(
        passports.at(-1)!,
        p,
        endpoint.protocol,
        endpoint.artifactRefs,
      )
    )
      return true;
    // An absent entity is conclusive only when its supplying chain was read.
    return [...node.dependencies].some((dep) => dependencyUnread(dep, p, seen));
  };
  const unreadCache = new Map<RecoveryNode, Map<AgentPassport, boolean>>();
  function unread(
    node: RecoveryNode,
    p: AgentPassport,
    seen = new Set<string>(),
  ): boolean {
    if (seen.size) return evaluateUnread(node, p, seen);
    const cache = unreadCache.get(node) ?? new Map<AgentPassport, boolean>();
    unreadCache.set(node, cache);
    if (!cache.has(p)) cache.set(p, evaluateUnread(node, p, seen));
    return cache.get(p)!;
  }
  const reportInstances = new Map(
    [...nodes.values()].map((node) => [
      node,
      [...nodes.values()].filter(
        (n) =>
          ['endpoint', 'artifact'].includes(n.kind) && reaches(node, n.key),
      ),
    ]),
  );
  // The report ledger also records uncertainty already in effect. A missing
  // slot under the same failed dependencies is a reported state; a newly failed
  // dependency is a new outage, even if both observations omit the slot.
  const failureSignature = (
    node: RecoveryNode,
    p: AgentPassport,
    seen = new Set<string>(),
  ): string[] => {
    if (seen.has(node.key) || !unread(node, p)) return [];
    seen.add(node.key);
    const value = node.versions.get(p);
    const status =
      value &&
      ('observationStatus' in value
        ? value.observationStatus
        : 'status' in value
          ? value.status
          : undefined);
    if (status && sourceFailureStatuses.has(status))
      return [`${node.key}:${status}`];
    return [...node.dependencies]
      .flatMap((dep) => {
        if (dep.startsWith('source:protocol:')) {
          const status = protocolStatus(
            p,
            dep.slice('source:protocol:'.length),
          );
          return failureStatuses.has(status) ? [`${dep}:${status}`] : [];
        }
        return nodes.has(dep) ? failureSignature(nodes.get(dep)!, p, seen) : [];
      })
      .sort();
  };
  const reported = (node: RecoveryNode, p: AgentPassport): boolean => {
    if (node.versions.has(p) || !unread(node, p)) return true;
    const currentFailure = failureSignature(node, passports[0]!);
    if (
      currentFailure.length &&
      canonicalSha256(currentFailure) ===
        canonicalSha256(failureSignature(node, p))
    )
      return true;
    return reportInstances.get(node)!.some((n) => n.versions.has(p));
  };
  return { nodes, reaches, unread, reported, findingMappingId };
}

/**
 * Replay each unread entity from its newest conclusive state. A composed prior
 * lets the unchanged pure engine compare aggregate assertions and schema keys
 * together, including healthy changes made on the recovery scan.
 * History is newest first, before current, and includes the predecessor.
 */
export function comparePassportsWithRecovery(
  previous: RecoveryObservation,
  current: AgentPassport,
  history: readonly RecoveryObservation[],
  ruleVersion: string = COMPARISON_RULE_VERSION,
): PassportComparison {
  const consecutive = comparePassports(previous.passport, current, ruleVersion);
  const sources = recoveredDiscoverySources(previous.passport, current);
  if (!sources.length || consecutive.state === 'incompatible_version')
    return consecutive;
  const prior = passportSchema.parse(previous.passport);
  const retained: { id: string; passport: AgentPassport }[] = [];
  for (const row of history.slice(0, RECOVERY_OBSERVATION_LIMIT)) {
    const parsed = passportSchema.safeParse(row.passport);
    if (!parsed.success || !sameRepresentation(parsed.data, current)) break;
    retained.push({ id: row.id, passport: parsed.data });
  }
  const recovery: ComparisonRecovery = {
    version: 'per-source-recovery-v1',
    window: RECOVERY_OBSERVATION_LIMIT,
    previousObservationId: previous.id,
    previousFingerprint: prior.fingerprints.passport.value,
    sources: [],
  };
  const { nodes, reaches, unread, reported, findingMappingId } = recoveryGraph([
    current,
    prior,
    ...retained.map((r) => r.passport),
  ]);
  // Both ledgers scan the whole bounded window, independently of the source
  // that admitted recovery. Absence is a state; missing proof keeps the prior.
  const ledger = new Map<string, (typeof retained)[number]>();
  const reportLedger = new Map<string, (typeof retained)[number]>();
  for (const node of nodes.values()) {
    const conclusive = retained.find((row) => !unread(node, row.passport));
    if (conclusive) ledger.set(node.key, conclusive);
    const report = retained.find((row) => reported(node, row.passport));
    if (report) reportLedger.set(node.key, report);
  }
  for (const source of sources) {
    const root =
      source.kind === 'protocol'
        ? `source:protocol:${source.id}`
        : `${source.kind === 'endpoint' ? 'endpoint' : 'artifact'}:${source.id}`;
    recovery.sources.push({
      source,
      baseObservationId:
        retained.find((row) => sourceRead(row.passport, source, current))?.id ??
        null,
      surfaces: [...nodes.values()].flatMap((node) => {
        const base = ledger.get(node.key);
        return base && unread(node, prior) && reaches(node, root)
          ? [
              {
                entityKind: node.kind,
                entityId: node.id,
                baseObservationId: base.id,
              },
            ]
          : [];
      }),
    });
  }
  const compose = (reports: boolean) => {
    const effective = structuredClone(prior);
    for (const collection of Object.keys(
      recoveryCollections,
    ) as RecoveryCollection[]) {
      // Keep normalized ordering: assertion event hashes cover the entire array.
      const items = new Map(
        recoveryItems(prior, collection).map((item) => [
          recoveryEntityId(collection, item),
          structuredClone(item),
        ]),
      );
      for (const node of nodes.values()) {
        if (node.collection !== collection || !unread(node, prior)) continue;
        const base = (
          reports && unread(node, current) ? reportLedger : ledger
        ).get(node.key);
        if (!base) continue;
        const value = node.versions.get(base.passport);
        if (value) items.set(node.id, structuredClone(value));
        else items.delete(node.id);
      }
      const sortKey = (item: RecoveryEntity) => {
        if ('subjectRefs' in item)
          return `${item.code}\0${item.subjectRefs.join()}`;
        return 'protocol' in item && collection === 'protocols'
          ? item.protocol
          : (item as { id: string }).id;
      };
      setRecoveryItems(
        effective,
        collection,
        [...items.values()].sort((a, b) => {
          const order = sortKey(a).localeCompare(sortKey(b), 'en');
          if (
            order ||
            !('subjectRefs' in a && 'subjectRefs' in b) ||
            !a.code.startsWith('OPENAPI_MCP_')
          )
            return order;
          // analyzeConsistency emits mappings in publisher-ID .sort() order
          // before its stable code/subject sort. Preserve that tie order even
          // when independent ledger states come from different observations.
          const left = findingMappingId(a) ?? '';
          const right = findingMappingId(b) ?? '';
          return left < right ? -1 : left > right ? 1 : 0;
        }),
      );
    }
    // Summaries are projections of independently replayed member slots. They are
    // never held unread by a failed peer. Only overwrite fields whose derivation
    // is proved by normalized observations; preserve unknown summary metadata.
    const observations = [prior, current, ...retained.map((r) => r.passport)];
    for (const protocol of ['mcp', 'mcp-server-card', 'openapi'] as const) {
      const members = (p: AgentPassport) =>
        protocol === 'mcp'
          ? p.endpoints.filter((e) => e.protocol === protocol)
          : p.artifacts.filter((a) => a.protocol === protocol);
      const status = (p: AgentPassport) => {
        const rows = members(p);
        return !rows.length
          ? 'not_detected'
          : rows.some((v) =>
                ['valid', 'truncated'].includes(
                  'observationStatus' in v ? v.observationStatus : v.status,
                ),
              )
            ? 'valid'
            : 'observed';
      };
      const row = effective.protocols.find((p) => p.protocol === protocol);
      const before = prior.protocols.find((p) => p.protocol === protocol);
      const after = current.protocols.find((p) => p.protocol === protocol);
      if (!row || !before || !after) continue;
      if (
        observations.every(
          (p) =>
            p.protocols.find((r) => r.protocol === protocol)?.status ===
            status(p),
        )
      )
        row.status = status(effective);
      const artifactRefs = (p: AgentPassport) =>
        p.artifacts
          .filter((a) => a.protocol === protocol)
          .map((a) => a.id)
          .sort();
      const endpointRefs = (p: AgentPassport) =>
        p.endpoints
          .filter((e) => e.protocol === protocol)
          .map((e) => e.id)
          .sort();
      for (const [field, derive] of [
        ['artifactRefs', artifactRefs],
        ['endpointRefs', endpointRefs],
      ] as const)
        if (
          observations.every(
            (p) =>
              canonicalSha256(
                p.protocols.find((r) => r.protocol === protocol)?.[field],
              ) === canonicalSha256(derive(p)),
          )
        )
          row[field] = derive(effective);
      if (protocol === 'mcp') {
        const revision = (p: AgentPassport) =>
          [
            ...new Set(
              p.endpoints
                .filter((e) => e.protocol === 'mcp')
                .flatMap((e) => (e.protocolVersion ? [e.protocolVersion] : [])),
            ),
          ]
            .sort()
            .join(',') || undefined;
        if (
          observations.every(
            (p) =>
              p.protocols.find((r) => r.protocol === protocol)?.revision ===
              revision(p),
          )
        )
          row.revision = revision(effective);
      } else {
        // The normalized card/document representation does not always retain a
        // per-document protocol revision (e.g. an empty OpenAPI document). A
        // matching member observation supplies the exact aggregate in that case.
        const signature = (p: AgentPassport) => canonicalSha256(members(p));
        const witness = [prior, ...retained.map((r) => r.passport)].find(
          (p) => signature(p) === signature(effective),
        );
        if (witness)
          row.revision = witness.protocols.find(
            (p) => p.protocol === protocol,
          )?.revision;
      }
    }
    // Normalization emits the empty mapping conclusion only when no mapping
    // exists. Independent replay can restore a mapping while an unread peer
    // keeps that empty slot inconclusive; rebuild this derived alternative.
    const findings = effective.consistency.findings.filter(
      (finding, _, all) =>
        !finding.code.startsWith('OPENAPI_MCP_') ||
        finding.evidenceRefs.length > 0 ||
        !all.some(
          (other) =>
            other.code === finding.code && other.evidenceRefs.length > 0,
        ),
    );
    effective.consistency.findings = findings;
    effective.consistency.summary = {
      checks: findings.length,
      matches: findings.filter((f) => f.status === 'match').length,
      mismatches: findings.filter((f) => f.status === 'mismatch').length,
      indeterminate: findings.filter((f) => f.status === 'indeterminate')
        .length,
      notApplicable: findings.filter((f) => f.status === 'not_applicable')
        .length,
    };
    effective.fingerprints.passport.value =
      computePassportFingerprint(effective);
    return effective;
  };
  const virtualPredecessor = compose(false);
  const comparison = comparePassports(virtualPredecessor, current);
  // Recompare the still-unread slots against their latest reported states.
  // This suppresses an outage already in effect, including aggregate assertion
  // events, without suppressing reversals or newly visible conclusive changes.
  const reportingPredecessor = compose(true);
  const changes =
    canonicalSha256(passportSemanticProjection(virtualPredecessor)) ===
    canonicalSha256(passportSemanticProjection(reportingPredecessor))
      ? comparison.changes
      : comparePassports(reportingPredecessor, current).changes;

  return finish(
    changes.length ? 'changed' : 'unchanged',
    prior,
    current,
    changes,
    recovery,
    ruleVersion,
  );
}

export function comparePassports(
  previousInput: unknown,
  currentInput: AgentPassport,
  ruleVersion: string = COMPARISON_RULE_VERSION,
): PassportComparison {
  // Current must be a freshly normalized current-version Passport; only the prior is version-gated.
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
      undefined,
      ruleVersion,
    );
  }
  const previous = passportSchema.parse(previousInput);
  if (
    previous.fingerprints.passport.value === current.fingerprints.passport.value
  )
    return finish('unchanged', previous, current, [], undefined, ruleVersion);
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
  const webMcpPresent = (passport: AgentPassport) =>
    ['valid', 'observed'].includes(
      passport.protocols.find((item) => item.protocol === 'webmcp')?.status ??
        '',
    );
  // With WebMCP present on both sides, a one-sided group is a single page's
  // declarations appearing or vanishing (rules v7). Only a page-target can have
  // two WebMCP artifacts, so this never fires for a page-less target.
  const webMcpOnBothSides = webMcpPresent(previous) && webMcpPresent(current);
  for (const key of [...incompleteGroups].sort())
    if (key.endsWith('|webmcp.tool') && pc.has(key) !== cc.has(key)) {
      // Otherwise the protocol rule explains a one-sided WebMCP group.
      if (!webMcpOnBothSides) continue;
      const artifactId = key.slice(0, -'|webmcp.tool'.length);
      changes.push(
        pc.has(key)
          ? event(
              'WEBMCP_DECLARATIONS_NOT_OBSERVED',
              'indeterminate',
              'artifact',
              artifactId,
              'artifacts',
              'PAGE_HTML_DECLARATIONS_NOT_OBSERVED_REMOVAL_NOT_PROVEN',
              { observed: true },
              { observed: false },
            )
          : event(
              'WEBMCP_DECLARATIONS_OBSERVED',
              'non_breaking',
              'artifact',
              artifactId,
              'artifacts',
              'PAGE_HTML_DECLARATIONS_NOW_OBSERVED',
              { observed: false },
              { observed: true },
            ),
      );
    } else
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
        item.kind === 'openapi.operation'
          ? 'OPENAPI_OPERATION_REMOVED'
          : 'CAPABILITY_REMOVED',
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
        item.kind === 'openapi.operation'
          ? 'OPENAPI_OPERATION_ADDED'
          : 'CAPABILITY_ADDED',
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
  const paymentCoverage = new Map<
    string,
    { before: boolean; after: boolean }
  >();
  for (const [id, before] of previousCapabilities) {
    const after = currentCapabilities.get(id);
    if (!after) continue;
    if (before.kind === 'mcp.tool' && after.kind === 'mcp.tool') {
      for (const [field, projectionField, direction, code] of [
        [
          'inputSchemaSha256',
          'inputSchemaCompatibility',
          'input',
          'MCP_TOOL_INPUT_SCHEMA_CHANGED',
        ],
        [
          'outputSchemaSha256',
          'outputSchemaCompatibility',
          'output',
          'MCP_TOOL_OUTPUT_SCHEMA_CHANGED',
        ],
      ] as const) {
        const a = before.metadata[field],
          b = after.metadata[field];
        if (a === b) continue;
        const previousSchema = before.metadata[projectionField],
          currentSchema = after.metadata[projectionField];
        if (previousSchema && currentSchema) {
          const analysis = analyzeSchemaCompatibility({
            previousSchema,
            currentSchema,
            direction,
          });
          for (const finding of analysis.findings)
            changes.push(
              event(
                code,
                finding.classification,
                'capability',
                after.protocolKey,
                finding.path,
                finding.reasonCode,
                finding.before,
                finding.after,
              ),
            );
          if (!analysis.findings.length)
            changes.push(
              event(
                code,
                'non_breaking',
                'capability',
                after.protocolKey,
                '$',
                'SCHEMA_DIRECTIONAL_CONTAINMENT_PROVEN',
                a,
                b,
              ),
            );
        } else {
          changes.push(
            event(
              code,
              'indeterminate',
              'capability',
              after.protocolKey,
              `capabilities.${field}`,
              'SCHEMA_COMPATIBILITY_EVIDENCE_UNAVAILABLE',
              a,
              b,
            ),
          );
        }
      }
    }
    if (
      before.kind === 'openapi.operation' &&
      after.kind === 'openapi.operation'
    ) {
      const asRecord = (value: unknown): Record<string, unknown> | undefined =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      const list = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value)
          ? value
              .map(asRecord)
              .filter((item): item is Record<string, unknown> => Boolean(item))
          : [];
      const beforeParameters = new Map(
        list(before.metadata.parameters).map((item) => [
          String(item.key),
          item,
        ]),
      );
      const afterParameters = new Map(
        list(after.metadata.parameters).map((item) => [String(item.key), item]),
      );
      for (const [key, parameter] of afterParameters) {
        const priorParameter = beforeParameters.get(key);
        if (!priorParameter) {
          changes.push(
            event(
              'OPENAPI_PARAMETER_ADDED',
              parameter.required === true ? 'breaking' : 'non_breaking',
              'openapi.parameter',
              `${after.protocolKey} ${key}`,
              'parameters',
              parameter.required === true
                ? 'NEW_REQUIRED_INPUT_PARAMETER'
                : 'NEW_OPTIONAL_INPUT_PARAMETER',
              null,
              { key, required: parameter.required === true },
            ),
          );
          continue;
        }
        if (priorParameter.required !== parameter.required)
          changes.push(
            event(
              'OPENAPI_PARAMETER_REQUIREDNESS_CHANGED',
              parameter.required === true ? 'breaking' : 'non_breaking',
              'openapi.parameter',
              `${after.protocolKey} ${key}`,
              'required',
              parameter.required === true
                ? 'OPTIONAL_PARAMETER_BECAME_REQUIRED'
                : 'REQUIRED_PARAMETER_BECAME_OPTIONAL',
              priorParameter.required,
              parameter.required,
            ),
          );
        if (priorParameter.schemaSha256 !== parameter.schemaSha256) {
          const analysis =
            priorParameter.schemaCompatibility && parameter.schemaCompatibility
              ? analyzeSchemaCompatibility({
                  previousSchema: priorParameter.schemaCompatibility,
                  currentSchema: parameter.schemaCompatibility,
                  direction: 'input',
                })
              : undefined;
          if (!analysis)
            changes.push(
              event(
                'OPENAPI_PARAMETER_SCHEMA_CHANGED',
                'indeterminate',
                'openapi.parameter',
                `${after.protocolKey} ${key}`,
                'schema',
                'SCHEMA_COMPATIBILITY_EVIDENCE_UNAVAILABLE',
                priorParameter.schemaSha256,
                parameter.schemaSha256,
              ),
            );
          else if (!analysis.findings.length)
            changes.push(
              event(
                'OPENAPI_PARAMETER_SCHEMA_CHANGED',
                'non_breaking',
                'openapi.parameter',
                `${after.protocolKey} ${key}`,
                '$',
                'SCHEMA_DIRECTIONAL_CONTAINMENT_PROVEN',
                priorParameter.schemaSha256,
                parameter.schemaSha256,
              ),
            );
          else
            for (const schemaFinding of analysis.findings)
              changes.push(
                event(
                  'OPENAPI_PARAMETER_SCHEMA_CHANGED',
                  schemaFinding.classification,
                  'openapi.parameter',
                  `${after.protocolKey} ${key}`,
                  schemaFinding.path,
                  schemaFinding.reasonCode,
                  schemaFinding.before,
                  schemaFinding.after,
                ),
              );
        }
      }
      for (const key of beforeParameters.keys())
        if (!afterParameters.has(key))
          changes.push(
            event(
              'OPENAPI_PARAMETER_REMOVED',
              'indeterminate',
              'openapi.parameter',
              `${after.protocolKey} ${key}`,
              'parameters',
              'REMOVED_PARAMETER_ACCEPTANCE_NOT_PROVEN',
              true,
              false,
            ),
          );

      const compareContent = (
        beforeContent: unknown,
        afterContent: unknown,
        direction: 'input' | 'output',
        entityId: string,
        code: string,
      ) => {
        const previousSlots = new Map(
          list(beforeContent).map((item) => [String(item.mediaType), item]),
        );
        const currentSlots = new Map(
          list(afterContent).map((item) => [String(item.mediaType), item]),
        );
        for (const [mediaType, previousSlot] of previousSlots) {
          const currentSlot = currentSlots.get(mediaType);
          if (!currentSlot) {
            changes.push(
              event(
                code,
                direction === 'input' ? 'breaking' : 'indeterminate',
                'openapi.schema',
                `${entityId} ${mediaType}`,
                'content',
                direction === 'input'
                  ? 'REQUEST_MEDIA_TYPE_REMOVED'
                  : 'RESPONSE_MEDIA_TYPE_REMOVAL_NOT_PROVEN',
                previousSlot.schemaSha256,
                null,
              ),
            );
            continue;
          }
          if (previousSlot.schemaSha256 === currentSlot.schemaSha256) continue;
          const analysis =
            previousSlot.schemaCompatibility && currentSlot.schemaCompatibility
              ? analyzeSchemaCompatibility({
                  previousSchema: previousSlot.schemaCompatibility,
                  currentSchema: currentSlot.schemaCompatibility,
                  direction,
                })
              : undefined;
          if (!analysis)
            changes.push(
              event(
                code,
                'indeterminate',
                'openapi.schema',
                `${entityId} ${mediaType}`,
                'schema',
                'SCHEMA_COMPATIBILITY_EVIDENCE_UNAVAILABLE',
                previousSlot.schemaSha256,
                currentSlot.schemaSha256,
              ),
            );
          else if (!analysis.findings.length)
            changes.push(
              event(
                code,
                'non_breaking',
                'openapi.schema',
                `${entityId} ${mediaType}`,
                '$',
                'SCHEMA_DIRECTIONAL_CONTAINMENT_PROVEN',
                previousSlot.schemaSha256,
                currentSlot.schemaSha256,
              ),
            );
          else
            for (const schemaFinding of analysis.findings)
              changes.push(
                event(
                  code,
                  schemaFinding.classification,
                  'openapi.schema',
                  `${entityId} ${mediaType}`,
                  schemaFinding.path,
                  schemaFinding.reasonCode,
                  schemaFinding.before,
                  schemaFinding.after,
                ),
              );
        }
        if (direction === 'input')
          for (const mediaType of currentSlots.keys())
            if (!previousSlots.has(mediaType))
              changes.push(
                event(
                  code,
                  'non_breaking',
                  'openapi.schema',
                  `${entityId} ${mediaType}`,
                  'content',
                  'REQUEST_MEDIA_TYPE_ADDED',
                  null,
                  mediaType,
                ),
              );
      };
      const beforeBody = asRecord(before.metadata.requestBody);
      const afterBody = asRecord(after.metadata.requestBody);
      if (
        beforeBody?.required !== afterBody?.required &&
        (beforeBody || afterBody)
      )
        changes.push(
          event(
            'OPENAPI_REQUEST_BODY_REQUIREDNESS_CHANGED',
            afterBody?.required === true ? 'breaking' : 'non_breaking',
            'openapi.request-body',
            after.protocolKey,
            'required',
            afterBody?.required === true
              ? 'OPTIONAL_REQUEST_BODY_BECAME_REQUIRED'
              : 'REQUIRED_REQUEST_BODY_BECAME_OPTIONAL',
            beforeBody?.required ?? false,
            afterBody?.required ?? false,
          ),
        );
      compareContent(
        beforeBody?.content,
        afterBody?.content,
        'input',
        after.protocolKey,
        'OPENAPI_REQUEST_SCHEMA_CHANGED',
      );

      const beforeResponses = new Map(
        list(before.metadata.responses).map((item) => [
          String(item.statusKey),
          item,
        ]),
      );
      const afterResponses = new Map(
        list(after.metadata.responses).map((item) => [
          String(item.statusKey),
          item,
        ]),
      );
      const ambiguous = [
        ...beforeResponses.keys(),
        ...afterResponses.keys(),
      ].some((key) => key === 'default' || /^[1-5]XX$/i.test(key));
      if (ambiguous)
        changes.push(
          event(
            'OPENAPI_RESPONSE_SET_CHANGED',
            'indeterminate',
            'openapi.response',
            after.protocolKey,
            'responses',
            'RESPONSE_SET_SEMANTICS_AMBIGUOUS',
            [...beforeResponses.keys()],
            [...afterResponses.keys()],
          ),
        );
      else
        for (const [statusKey, previousResponse] of beforeResponses) {
          const currentResponse = afterResponses.get(statusKey);
          if (!currentResponse) {
            changes.push(
              event(
                'OPENAPI_RESPONSE_SET_CHANGED',
                'indeterminate',
                'openapi.response',
                `${after.protocolKey} ${statusKey}`,
                'responses',
                'RESPONSE_STATUS_REMOVAL_COMPATIBILITY_NOT_PROVEN',
                statusKey,
                null,
              ),
            );
            continue;
          }
          compareContent(
            previousResponse.content,
            currentResponse.content,
            'output',
            `${after.protocolKey} ${statusKey}`,
            'OPENAPI_RESPONSE_SCHEMA_CHANGED',
          );
        }
      if (paymentChecked(before) !== paymentChecked(after))
        paymentCoverage.set(inventoryKey(after), {
          before: paymentChecked(before),
          after: paymentChecked(after),
        });
      else
        changes.push(
          ...paymentDeclarationChanges(
            id,
            before,
            after,
            !incompleteGroups.has(inventoryKey(after)),
          ),
        );
      if (before.metadata.operationId !== after.metadata.operationId)
        changes.push(
          event(
            'OPENAPI_OPERATION_ID_CHANGED',
            'informational',
            'openapi.operation',
            after.protocolKey,
            'operationId',
            'CODE_GENERATION_METADATA_CHANGED',
            before.metadata.operationId,
            after.metadata.operationId,
          ),
        );
    }
    const webMcpControlKeys = ['controls', 'controlCount', 'controlsTruncated'];
    if (before.kind === 'webmcp.tool' && after.kind === 'webmcp.tool') {
      const controls = (item: typeof before) =>
        Object.fromEntries(
          webMcpControlKeys.map((key) => [key, item.metadata[key] ?? null]),
        );
      if (
        canonicalSha256(controls(before)) !== canonicalSha256(controls(after))
      )
        changes.push(
          event(
            'WEBMCP_TOOL_CONTROLS_CHANGED',
            'indeterminate',
            'capability',
            id,
            'capabilities.metadata.controls',
            'DECLARED_FORM_CONTROLS_CHANGED_COMPATIBILITY_NOT_INFERRED',
            controls(before),
            controls(after),
          ),
        );
    }
    const bd = display(before),
      ad = display(after);
    if (canonicalSha256(bd) !== canonicalSha256(ad)) {
      const contractKeys = new Set([
        'inputSchemaSha256',
        'outputSchemaSha256',
        'inputSchemaCompatibility',
        'outputSchemaCompatibility',
        ...(after.kind === 'webmcp.tool' ? webMcpControlKeys : []),
        // Explained by the v6 payment rules, never as generic metadata.
        ...(after.kind === 'openapi.operation' ? ['paymentDeclaration'] : []),
      ]);
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
  // One event per document, not per operation: the observer changed, not the publisher.
  for (const [key, coverage] of [...paymentCoverage].sort(([a], [b]) =>
    a.localeCompare(b, 'en'),
  ))
    changes.push(
      event(
        'OPENAPI_PAYMENT_DECLARATION_COVERAGE_CHANGED',
        'informational',
        'inventory',
        key,
        'capabilities.metadata.paymentDeclaration',
        'PAYMENT_DECLARATION_OBSERVATION_COVERAGE_CHANGED',
        { checked: coverage.before },
        { checked: coverage.after },
      ),
    );
  const pe = mapById(previous.endpoints),
    ce = mapById(current.endpoints);
  for (const [id, before] of pe) {
    const after = ce.get(id);
    if (!after) {
      const protocolFailed = failureStatuses.has(
        current.protocols.find((p) => p.protocol === before.protocol)?.status ??
          '',
      );
      if (
        protocolFailed ||
        discoverySourceUnobserved(
          previous,
          current,
          before.protocol,
          before.artifactRefs,
        )
      )
        changes.push(
          event(
            'ENDPOINT_OBSERVATION_FAILED',
            'indeterminate',
            'endpoint',
            id,
            'endpoints',
            protocolFailed
              ? 'CURRENT_PROTOCOL_OBSERVATION_FAILED'
              : 'DISCOVERY_SOURCE_NOT_OBSERVED_REMOVAL_NOT_PROVEN',
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
    else if (wasPublic && after.observationStatus === 'payment_required')
      changes.push(
        event(
          'ACCESS_NOW_REQUIRES_PAYMENT',
          'breaking',
          'endpoint',
          id,
          'endpoints.observationStatus',
          'PUBLIC_OBSERVATION_NOW_PAYMENT_REQUIRED',
          before.observationStatus,
          after.observationStatus,
        ),
      );
    else if (
      ['auth_required', 'forbidden', 'payment_required'].includes(
        before.observationStatus,
      ) &&
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
          ? event(
              'ENDPOINT_OBSERVATION_FAILED',
              'indeterminate',
              'endpoint',
              id,
              'endpoints',
              'NEW_ENDPOINT_COULD_NOT_BE_OBSERVED',
              null,
              { url: after.url, status: after.observationStatus },
            )
          : event(
              'ENDPOINT_ADDED',
              'non_breaking',
              'endpoint',
              id,
              'endpoints',
              'CURRENTLY_PRESENT_PREVIOUSLY_ABSENT',
              null,
              { url: after.url },
            ),
      );
  if (
    canonicalSha256(previous.accessAssertions) !==
    canonicalSha256(current.accessAssertions)
  )
    changes.push(
      event(
        'ACCESS_METADATA_CHANGED',
        'indeterminate',
        'access',
        'assertions',
        'accessAssertions',
        'DECLARED_OR_OBSERVED_ACCESS_METADATA_CHANGED',
        {
          count: previous.accessAssertions.length,
          sha256: canonicalSha256(previous.accessAssertions),
        },
        {
          count: current.accessAssertions.length,
          sha256: canonicalSha256(current.accessAssertions),
        },
      ),
    );
  const pp = new Map(previous.protocols.map((p) => [p.protocol, p])),
    cp = new Map(current.protocols.map((p) => [p.protocol, p]));
  for (const [id, before] of pp) {
    const after = cp.get(id)!;
    const wasPresent = ['valid', 'observed'].includes(before.status),
      isPresent = ['valid', 'observed'].includes(after.status);
    if (id === 'webmcp' && wasPresent && !isPresent)
      // Scripted tools and other pages are unobserved, so absence proves nothing.
      changes.push(
        event(
          'WEBMCP_DECLARATIONS_NOT_OBSERVED',
          'indeterminate',
          'protocol',
          id,
          'protocols.status',
          'ROOT_HTML_DECLARATIONS_NOT_OBSERVED_REMOVAL_NOT_PROVEN',
          before.status,
          after.status,
        ),
      );
    else if (wasPresent && !isPresent) {
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
      else if (
        after.status === 'not_detected' &&
        discoverySourceUnobserved(
          previous,
          current,
          id,
          id === 'mcp'
            ? previous.endpoints
                .filter((item) => item.protocol === 'mcp')
                .flatMap((item) => item.artifactRefs)
            : undefined,
        )
      )
        changes.push(
          event(
            'PROTOCOL_OBSERVATION_FAILED',
            'indeterminate',
            'protocol',
            id,
            'protocols.status',
            'DISCOVERY_SOURCE_NOT_OBSERVED_REMOVAL_NOT_PROVEN',
            before.status,
            after.status,
          ),
        );
      else if (conclusiveAbsent(after.status))
        changes.push(
          event(
            id === 'openapi'
              ? 'OPENAPI_SURFACE_REMOVED'
              : 'PROTOCOL_SURFACE_REMOVED',
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
          id === 'openapi' ? 'OPENAPI_SURFACE_ADDED' : 'PROTOCOL_SURFACE_ADDED',
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
        {
          count: previous.identityAssertions.length,
          sha256: canonicalSha256(previous.identityAssertions),
        },
        {
          count: current.identityAssertions.length,
          sha256: canonicalSha256(current.identityAssertions),
        },
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
  return finish('changed', previous, current, changes, undefined, ruleVersion);
}

export function baselineComparison(
  currentInput: AgentPassport,
  ruleVersion: string = COMPARISON_RULE_VERSION,
): PassportComparison {
  return finish(
    'baseline',
    null,
    passportSchema.parse(currentInput),
    [],
    undefined,
    ruleVersion,
  );
}
