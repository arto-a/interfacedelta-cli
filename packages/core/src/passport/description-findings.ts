import type { AgentPassport } from '@interfacedelta/contracts';
import {
  checkToolDescription,
  descriptionCheckContext,
  DESCRIPTION_CHARACTER_LIMIT,
  DESCRIPTION_CHECKS_VERSION,
  type DescriptionCheckFact,
} from '../evidence/description-checks';
import { canonicalSha256 } from './canonical-json';

export const DECLARED_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;
export type DeclaredHintChange = {
  capabilityId: string;
  code: 'DECLARED_HINT_CHANGED';
  hint: (typeof DECLARED_HINTS)[number];
  before: boolean | null;
  after: boolean | null;
  classification: 'needs_review' | 'informational';
};
export type DescriptionFindings = {
  hintChanges: DeclaredHintChange[];
  version: typeof DESCRIPTION_CHECKS_VERSION;
  evidenceClass: 'INTERFACEDELTA_DERIVED';
  tools: {
    capabilityId: string;
    facts: DescriptionCheckFact[];
    schemaTextAvailable: boolean;
    annotationTextAvailable: boolean;
  }[];
  changes: {
    capabilityId: string;
    code: DescriptionCheckFact['code'];
    location: DescriptionCheckFact['location'];
    count: number;
    classification: 'needs_review';
  }[];
};
/** Sidecar only: never attach to a canonical Passport or its semantic projection. */
export function deriveDescriptionFindings(
  current: AgentPassport,
  previous?: AgentPassport | null,
): DescriptionFindings {
  const tools = current.capabilities.filter((item) => item.kind === 'mcp.tool');
  const revisions = new Map<AgentPassport, Map<string, string | undefined>>();
  for (const passport of [current, previous]) {
    if (!passport) continue;
    const values = new Map<string, string | undefined>();
    for (const item of passport.identityAssertions) {
      if (
        item.sourceProtocol === 'mcp' &&
        item.assertionType === 'implementation_identity' &&
        item.field === 'version'
      )
        values.set(
          item.sourceRef,
          values.has(item.sourceRef) ? undefined : item.value,
        );
    }
    revisions.set(passport, values);
  }
  const revision = (passport: AgentPassport, sourceRef: string) =>
    revisions.get(passport)?.get(sourceRef);
  const declarations = new Map(
    [current, previous]
      .filter((p): p is AgentPassport => !!p)
      .map((p) => [
        p,
        new Map(
          p.protocolDeclarations?.items.map((item) => [
            JSON.stringify([item.sourceRef, item.protocolKey]),
            item.values,
          ]),
        ),
      ]),
  );
  const annotations = (
    passport: AgentPassport,
    tool: AgentPassport['capabilities'][number],
  ) =>
    tool.metadata.annotations ??
    declarations
      .get(passport)
      ?.get(JSON.stringify([tool.sourceRef, tool.protocolKey]));
  const contexts = new Map<
    AgentPassport,
    Map<string, ReturnType<typeof descriptionCheckContext>>
  >();
  for (const passport of [current, previous]) {
    if (!passport) continue;
    const names = new Map<string, string[]>();
    for (const tool of passport.capabilities) {
      if (tool.kind !== 'mcp.tool') continue;
      const group = names.get(tool.sourceRef) ?? [];
      group.push(tool.name);
      names.set(tool.sourceRef, group);
    }
    const budget = { remaining: DESCRIPTION_CHARACTER_LIMIT };
    contexts.set(
      passport,
      new Map(
        [...names].map(([source, names]) => [
          source,
          descriptionCheckContext(names, budget),
        ]),
      ),
    );
  }
  const previousTools = new Map(
    previous?.capabilities.map((tool) => [tool.id, tool]),
  );
  const check = (
    passport: AgentPassport,
    tool: AgentPassport['capabilities'][number],
  ) =>
    checkToolDescription(
      {
        name: tool.name,
        description: tool.description,
        // Compatibility projections intentionally omit prose; never treat them as raw schemas.
        inputSchema: tool.metadata.inputSchema,
        annotations: annotations(passport, tool),
      },
      contexts.get(passport)!.get(tool.sourceRef),
    );
  const completePreviousSources = new Set(
    previous?.inventoryGroups
      .filter((group) => group.kind === 'mcp.tool' && group.complete)
      .map((group) => group.sourceRef),
  );
  const changes: DescriptionFindings['changes'] = [];
  const hintChanges: DeclaredHintChange[] = [];
  const results = tools.map((tool) => {
    const candidate = previousTools.get(tool.id);
    const before =
      candidate?.kind === 'mcp.tool' && candidate.sourceRef === tool.sourceRef
        ? candidate
        : undefined;
    const facts = check(current, tool);
    if (before && previous) {
      const old = check(previous, before);
      const oldHints = annotations(previous, before) as
        Record<string, unknown> | undefined;
      const newHints = annotations(current, tool) as
        Record<string, unknown> | undefined;
      for (const hint of DECLARED_HINTS) {
        const beforeValue =
          typeof oldHints?.[hint] === 'boolean'
            ? (oldHints[hint] as boolean)
            : null;
        const afterValue =
          typeof newHints?.[hint] === 'boolean'
            ? (newHints[hint] as boolean)
            : null;
        if (beforeValue === afterValue) continue;
        const riskier =
          hint === 'readOnlyHint'
            ? beforeValue === true && afterValue !== true
            : (hint === 'destructiveHint' || hint === 'openWorldHint') &&
              beforeValue === false &&
              afterValue === true;
        hintChanges.push({
          capabilityId: tool.id,
          code: 'DECLARED_HINT_CHANGED',
          hint,
          before: beforeValue,
          after: afterValue,
          classification: riskier ? 'needs_review' : 'informational',
        });
      }
      const currentBudget = contexts.get(current)!.get(tool.sourceRef)!.budget;
      const previousBudget = contexts
        .get(previous)!
        .get(before.sourceRef)!.budget;
      if (
        before.description !== undefined &&
        tool.description !== undefined &&
        tool.description.length <= currentBudget.remaining &&
        before.description.length <= previousBudget.remaining
      ) {
        currentBudget.remaining -= tool.description.length;
        previousBudget.remaining -= before.description.length;
        facts.push(
          ...checkToolDescription({
            name: '',
            descriptionComparison: {
              previousHash: canonicalSha256(before.description),
              currentHash: canonicalSha256(tool.description),
              previousRevision: revision(previous, before.sourceRef),
              currentRevision: revision(current, tool.sourceRef),
            },
          }),
        );
      }
      for (const fact of facts)
        if (
          !old.some(
            (item) =>
              item.code === fact.code && item.location === fact.location,
          )
        )
          changes.push({
            capabilityId: tool.id,
            ...fact,
            classification: 'needs_review',
          });
    }
    if (!before && completePreviousSources.has(tool.sourceRef)) {
      for (const fact of facts)
        changes.push({
          capabilityId: tool.id,
          ...fact,
          classification: 'needs_review',
        });
    }
    return {
      capabilityId: tool.id,
      facts,
      schemaTextAvailable: Object.hasOwn(tool.metadata, 'inputSchema'),
      annotationTextAvailable: annotations(current, tool) !== undefined,
    };
  });
  return {
    version: DESCRIPTION_CHECKS_VERSION,
    evidenceClass: 'INTERFACEDELTA_DERIVED',
    hintChanges,
    tools: results,
    changes,
  };
}
