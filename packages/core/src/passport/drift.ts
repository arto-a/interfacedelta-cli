import { z } from 'zod-v3';
import { passportSchema, type AgentPassport } from '@interfacedelta/contracts';
import { analyzeSchemaCompatibility } from '@interfacedelta/schema-compatibility';
import { canonicalSha256 } from './canonical-json';

export const COMPARISON_RULE_VERSION = 'compatibility-rules-v8' as const;
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

export function comparePassports(
  previousInput: unknown,
  currentInput: AgentPassport,
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
  return finish('changed', previous, current, changes);
}

export function baselineComparison(
  currentInput: AgentPassport,
): PassportComparison {
  return finish('baseline', null, passportSchema.parse(currentInput), []);
}
