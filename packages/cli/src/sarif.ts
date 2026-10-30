import { canonicalSha256 } from '@interfacedelta/core';
import { changeExplanation, subjectLabel } from './format';
import { sanitizeTerminal } from './sanitize';
import { CLI_VERSION, type CheckResult } from './types';

export const SARIF_RESULT_LIMIT = 1000;

export type SarifEntry = {
  /** Dependency name, when the check came from a dependencies file. */
  name?: string;
  /** Repository-relative baseline path; code scanning anchors results here. */
  baselineUri: string;
  result?: CheckResult;
  error?: string;
};

const LEVEL = { block: 'error', warn: 'warning', allow: 'note' } as const;

/**
 * SARIF 2.1.0 for GitHub code scanning, one result per blocked, warned or
 * accepted change; other allowed changes are left out. Remote text is
 * control-stripped and bounded.
 */
export function toSarif(entries: SarifEntry[]) {
  const rules = new Map<string, { id: string; text: string }>();
  const results: unknown[] = [];
  let omitted = 0;
  for (const entry of entries) {
    const result = entry.result;
    if (!result) continue;
    for (const [index, change] of result.comparison.changes.entries()) {
      const decision = result.decisions[index]!;
      if (decision.action === 'allow' && decision.source !== 'acceptance')
        continue;
      if (results.length >= SARIF_RESULT_LIMIT) {
        omitted++;
        continue;
      }
      const ruleId = sanitizeTerminal(change.code, 100);
      if (!rules.has(ruleId))
        rules.set(ruleId, {
          id: ruleId,
          text: `InterfaceDelta ${ruleId.toLowerCase().replace(/_/g, ' ')}`,
        });
      const detail = changeExplanation(change, result);
      const prefix = entry.name ? `${sanitizeTerminal(entry.name, 64)}: ` : '';
      results.push({
        ruleId,
        level: LEVEL[decision.action],
        message: {
          text: `${prefix}${sanitizeTerminal(change.classification, 40)} ${ruleId} on ${sanitizeTerminal(result.targetScope.origin, 300)} (${subjectLabel(result, change)})${detail ? ` — ${sanitizeTerminal(detail, 240)}` : ''}. Next: ${decision.card.step}`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: entry.baselineUri },
              region: { startLine: 1 },
            },
          },
        ],
        partialFingerprints: {
          'interfacedeltaChange/v1': canonicalSha256({
            dependency: entry.name ?? null,
            scope: result.targetScope,
            semanticId: change.semanticId,
            code: change.code,
          }),
        },
        properties: {
          classification: change.classification,
          origin: result.targetScope.origin,
          decision: decision.action,
          decisionSource: decision.source,
          attention: decision.card.attention,
          domains: decision.card.domains,
          ...(entry.name ? { dependency: entry.name } : {}),
          ...(decision.owner
            ? { owner: sanitizeTerminal(decision.owner, 100) }
            : {}),
          ...(decision.rule ? { rule: decision.rule } : {}),
          ...(decision.accepted
            ? { acceptedUntil: decision.accepted.expires }
            : {}),
        },
      });
    }
  }
  const notifications = entries
    .filter((entry) => entry.error)
    .map((entry) => ({
      level: 'error',
      message: {
        text: `${entry.name ? `${sanitizeTerminal(entry.name, 64)}: ` : ''}${sanitizeTerminal(entry.error, 500)}`,
      },
    }));
  if (omitted)
    notifications.push({
      level: 'warning',
      message: { text: `${omitted} additional results omitted.` },
    });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'InterfaceDelta',
            version: CLI_VERSION,
            informationUri: 'https://interfacedelta.com/docs',
            rules: [...rules.values()]
              .sort((a, b) => a.id.localeCompare(b.id, 'en'))
              .map((rule) => ({
                id: rule.id,
                shortDescription: { text: rule.text },
              })),
          },
        },
        invocations: [
          {
            executionSuccessful: entries.every((entry) => !entry.error),
            toolExecutionNotifications: notifications,
          },
        ],
        results,
      },
    ],
  };
}
