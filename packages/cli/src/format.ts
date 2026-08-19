import { canonicalJson } from '@interfacedelta/core';
import type { AgentPassport } from '@interfacedelta/contracts';
import { sanitizeTerminal } from './sanitize';
import type { CheckResult } from './types';

const capabilityCount = (passport: AgentPassport, kind: string) =>
  passport.capabilities.filter((item) => item.kind === kind).length;
const protocol = (passport: AgentPassport, name: string) =>
  passport.protocols.find((item) => item.protocol === name);

export function formatInspection(passport: AgentPassport): string {
  const consistency = passport.consistency.summary;
  const mcp = protocol(passport, 'mcp');
  return [
    'InterfaceDelta',
    '',
    'Subject',
    sanitizeTerminal(passport.subject.origin),
    '',
    'Protocols',
    `ARD   ${sanitizeTerminal(protocol(passport, 'ard')?.status ?? 'not observed')}`,
    `A2A   ${sanitizeTerminal(protocol(passport, 'a2a')?.status ?? 'not observed')}`,
    `MCP   ${sanitizeTerminal(mcp?.status ?? 'not observed')}${mcp?.revision ? ` · ${sanitizeTerminal(mcp.revision)}` : ''}`,
    '',
    'Capabilities',
    `${capabilityCount(passport, 'mcp.tool')} MCP tools`,
    `${capabilityCount(passport, 'mcp.resource')} MCP resources`,
    `${capabilityCount(passport, 'mcp.prompt')} MCP prompts`,
    `${capabilityCount(passport, 'a2a.skill')} A2A skills`,
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

export function formatCheck(result: CheckResult): string {
  const { comparison, policy } = result;
  return [
    'InterfaceDelta compatibility check',
    '',
    `Target: ${sanitizeTerminal(result.targetScope.origin)}`,
    `Baseline: sha256:${result.previousFingerprint}`,
    `Current: sha256:${result.currentFingerprint}`,
    `Comparison: ${comparison.state}`,
    `Breaking: ${comparison.counts.breaking}`,
    `Non-breaking: ${comparison.counts.nonBreaking}`,
    `Needs review: ${comparison.counts.indeterminate}`,
    `Informational: ${comparison.counts.informational}`,
    `Policy: ${policy.version} (${policy.failOn.join(',')})`,
    `Result: ${policy.result.toUpperCase()}`,
  ].join('\n');
}

export const machineJson = (value: unknown): string => `${canonicalJson(value)}\n`;
