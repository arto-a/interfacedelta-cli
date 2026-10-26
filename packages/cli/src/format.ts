import {
  canonicalJson,
  describeChangeDetail,
} from '@interfacedelta/core';
import type { AgentPassport } from '@interfacedelta/contracts';
import { sanitizeTerminal } from './sanitize';
import type { BaselineSetOutcome } from './dependencies';
import type { CheckResult, CheckSetResult } from './types';

const capabilities = (passport: AgentPassport, kind: string) =>
  passport.capabilities.filter((item) => item.kind === kind);
const capabilityCount = (passport: AgentPassport, kind: string) =>
  capabilities(passport, kind).length;
const protocol = (passport: AgentPassport, name: string) =>
  passport.protocols.find((item) => item.protocol === name);
const status = (passport: AgentPassport, name: string) =>
  sanitizeTerminal(protocol(passport, name)?.status ?? 'not observed');
const count = (value: number, singular: string, plural = `${singular}s`) =>
  `${value} ${value === 1 ? singular : plural}`;

/** Facts the Passport records as declared by the publisher, never exercised. */
export function declaredFacts(passport: AgentPassport): string[] {
  const appTools = capabilities(passport, 'mcp.tool').filter(
    (item) => typeof item.metadata.uiResourceUri === 'string',
  ).length;
  const paidOperations = capabilities(passport, 'openapi.operation').filter(
    (item) =>
      item.metadata.paymentDeclaration !== null &&
      typeof item.metadata.paymentDeclaration === 'object' &&
      !Array.isArray(item.metadata.paymentDeclaration),
  ).length;
  const paymentRequired = passport.endpoints.filter(
    (item) =>
      item.protocol === 'mcp' && item.observationStatus === 'payment_required',
  ).length;
  return [
    appTools &&
      `${count(appTools, 'MCP tool')} ${appTools === 1 ? 'declares' : 'declare'} an MCP Apps UI (not fetched)`,
    paidOperations &&
      `${count(paidOperations, 'OpenAPI operation')} ${paidOperations === 1 ? 'declares' : 'declare'} payment (publisher-declared; not verified; nothing paid)`,
    paymentRequired &&
      `${count(paymentRequired, 'MCP endpoint')} answered HTTP 402 (payment required)`,
  ].filter((line): line is string => Boolean(line));
}

export function formatInspection(passport: AgentPassport): string {
  const consistency = passport.consistency.summary;
  const mcp = protocol(passport, 'mcp');
  const openapiOperations = capabilityCount(passport, 'openapi.operation');
  const webmcpTools = capabilityCount(passport, 'webmcp.tool');
  const declared = declaredFacts(passport);
  return [
    'InterfaceDelta',
    '',
    'Subject',
    sanitizeTerminal(passport.subject.origin),
    '',
    'Protocols',
    `ARD      ${status(passport, 'ard')}`,
    `A2A      ${status(passport, 'a2a')}`,
    `MCP      ${sanitizeTerminal(mcp?.status ?? 'not observed')}${mcp?.revision ? ` · ${sanitizeTerminal(mcp.revision)}` : ''}`,
    `OpenAPI  ${status(passport, 'openapi')}`,
    `WebMCP   ${status(passport, 'webmcp')} (experimental)`,
    '',
    'Capabilities',
    `${capabilityCount(passport, 'mcp.tool')} MCP tools`,
    `${capabilityCount(passport, 'mcp.resource')} MCP resources`,
    `${capabilityCount(passport, 'mcp.prompt')} MCP prompts`,
    `${capabilityCount(passport, 'a2a.skill')} A2A skills`,
    ...(openapiOperations
      ? [count(openapiOperations, 'OpenAPI operation')]
      : []),
    ...(webmcpTools ? [count(webmcpTools, 'WebMCP form tool')] : []),
    ...(declared.length ? ['', 'Declared', ...declared] : []),
    '',
    'Consistency',
    `${consistency.matches} matches`,
    `${consistency.mismatches} mismatches`,
    `${consistency.indeterminate} indeterminate`,
    '',
    'Fingerprint',
    `sha256:${passport.fingerprints.passport.value}`,
  ].join('\n');
}

type Change = CheckResult['comparison']['changes'][number];

/** Change codes named for a public observation (compatibility rules v3, v4). */
const ACCESS_CODES = new Set([
  'ACCESS_NOW_REQUIRES_AUTH',
  'ACCESS_NOW_FORBIDDEN',
  'ACCESS_NOW_REQUIRES_PAYMENT',
  'ACCESS_BECAME_PUBLICLY_OBSERVABLE',
]);
const SIGNED_IN_NOTE =
  'Observed signed in with the configured token, not as public access.';

/**
 * Deterministic plain-text explanation of a change, or undefined. Unsanitized.
 * With the check result, an access change on the signed-in endpoint says so:
 * its code is named for public access, which the check did not observe.
 */
export function changeExplanation(
  change: Change,
  result?: CheckResult,
): string | undefined {
  const detail = describeChangeDetail({
    code: change.code,
    reasonCode: change.reasonCode,
    path: change.path,
    entityId: change.entityId,
    before: change.before,
    after: change.after,
  });
  if (
    !ACCESS_CODES.has(change.code) ||
    !result?.subjects[change.entityId]?.signedIn
  )
    return detail;
  return detail ? `${detail} ${SIGNED_IN_NOTE}` : SIGNED_IN_NOTE;
}

export const CHECK_CHANGE_LIMIT = 10;

/** `mcp.tool create_pull_request`, or the entity id when no name is known. */
export function subjectLabel(result: CheckResult, change: Change): string {
  const subject = result.subjects[change.entityId];
  return subject
    ? `${sanitizeTerminal(subject.kind, 60)} ${sanitizeTerminal(subject.name, 200)}`
    : `${sanitizeTerminal(change.entityKind, 80)}: ${sanitizeTerminal(change.entityId, 160)}`;
}

const ACTION_RANK = { block: 0, warn: 1, allow: 2 } as const;

/** Changes worth a line: blocked, warned, or accepted, most serious first. */
function notableDecisions(result: CheckResult) {
  return result.comparison.changes
    .map((change, index) => ({ change, decision: result.decisions[index]! }))
    .filter(
      ({ decision }) =>
        decision.action !== 'allow' || decision.source === 'acceptance',
    )
    .sort(
      (a, b) => ACTION_RANK[a.decision.action] - ACTION_RANK[b.decision.action],
    );
}

function decisionLines(
  result: CheckResult,
  indent: string,
  dependency?: string,
): string[] {
  const notable = notableDecisions(result);
  const shown = notable.slice(0, CHECK_CHANGE_LIMIT);
  const lines = shown.flatMap(({ change, decision }) => {
    const detail = changeExplanation(change, result);
    const label =
      decision.source === 'acceptance'
        ? 'ACCEPTED'
        : decision.action.toUpperCase();
    const who = [
      decision.owner && `owner ${sanitizeTerminal(decision.owner, 100)}`,
      decision.rule && `rule ${decision.rule}`,
      decision.note && sanitizeTerminal(decision.note, 300),
      decision.accepted &&
        `accepted${decision.accepted.by ? ` by ${sanitizeTerminal(decision.accepted.by, 100)}` : ''} until ${decision.accepted.expires}: ${sanitizeTerminal(decision.accepted.reason, 300)}`,
    ].filter(Boolean);
    return [
      `${indent}- ${label} ${sanitizeTerminal(change.classification, 40)} ${sanitizeTerminal(change.code, 100)} ${subjectLabel(result, change)}${detail ? ` — ${sanitizeTerminal(detail, 240)}` : ''}`,
      ...(who.length ? [`${indent}    ${who.join(' · ')}`] : []),
      ...(decision.source === 'acceptance'
        ? []
        : [`${indent}    next: ${decision.card.step}`]),
      ...(dependency && decision.action === 'block'
        ? [
            `${indent}    accept: interfacedelta accept ${sanitizeTerminal(dependency, 64)} ${change.semanticId} --reason "<why>" --days 14`,
          ]
        : []),
    ];
  });
  if (notable.length > shown.length)
    lines.push(`${indent}- and ${notable.length - shown.length} more`);
  for (const note of result.notes)
    lines.push(`${indent}note: ${sanitizeTerminal(note, 300)}`);
  return lines;
}

export function formatCheck(result: CheckResult): string {
  const { comparison, policy } = result;
  const lines = decisionLines(result, '');
  return [
    'InterfaceDelta compatibility check',
    '',
    `Target: ${sanitizeTerminal(result.inspectionUrl)}`,
    `Baseline: sha256:${result.previousFingerprint}`,
    `Current: sha256:${result.currentFingerprint}`,
    `Comparison: ${comparison.state}`,
    `Breaking: ${comparison.counts.breaking}`,
    `Non-breaking: ${comparison.counts.nonBreaking}`,
    `Needs review: ${comparison.counts.indeterminate}`,
    `Informational: ${comparison.counts.informational}`,
    `Policy: ${policy.version} (${policy.failOn.join(',')})`,
    `Result: ${policy.result.toUpperCase()}`,
    ...(lines.length ? ['', 'Changes', ...lines] : []),
  ].join('\n');
}

export const machineJson = (value: unknown): string =>
  `${canonicalJson(value)}\n`;

export function formatCheckSet(result: CheckSetResult): string {
  const lines = result.dependencies.flatMap((item) => {
    const name = sanitizeTerminal(item.name, 64);
    if (item.status === 'error')
      return [
        `- ${name}  ERROR (${item.error.kind})  ${sanitizeTerminal(item.error.message, 300)}`,
      ];
    const { comparison, policy } = item.result;
    return [
      `- ${name}  ${policy.result.toUpperCase()}  ${comparison.state}  ${sanitizeTerminal(item.result.inspectionUrl, 300)}`,
      ...decisionLines(item.result, '    ', item.name),
    ];
  });
  return [
    'InterfaceDelta compatibility check',
    '',
    `Policy: ${result.policy.version} (${result.policy.failOn.join(',')}); on-error: ${result.policy.onError}`,
    `Dependencies: ${result.counts.dependencies}`,
    `Failed: ${result.counts.failed}`,
    `Errors: ${result.counts.errored}`,
    ...(result.counts.skipped
      ? [
          `Skipped (no secrets in a fork pull request): ${result.counts.skipped}`,
        ]
      : []),
    `Blocked: ${result.counts.blocked}`,
    `Warned: ${result.counts.warned}`,
    ...(result.counts.accepted ? [`Accepted: ${result.counts.accepted}`] : []),
    `Result: ${result.result.toUpperCase()}`,
    '',
    'Dependencies',
    ...lines,
  ].join('\n');
}

export function formatBaselineSet(outcomes: BaselineSetOutcome[]): string {
  return [
    'InterfaceDelta baselines',
    '',
    ...outcomes.map(
      (item) =>
        `- ${sanitizeTerminal(item.name, 64)}  ${item.status}  ${sanitizeTerminal(item.baseline, 300)}${item.message ? `  ${sanitizeTerminal(item.message, 300)}` : ''}`,
    ),
    '',
    'Review publisher-provided metadata before committing baselines.',
  ].join('\n');
}
