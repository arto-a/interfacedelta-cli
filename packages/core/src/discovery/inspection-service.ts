import type { A2aSummary, ArdSummary, DiscoveryReport, DiscoveryResult } from '@interfacedelta/contracts';
import { ConstrainedHttpsClient, discoveryUrl, type RetrievalResult, type SafeOutboundClient } from '../scanner/outbound-boundary';
import { parsePublicHttpsOrigin } from '../scanner/target-policy';
import { observeMcp } from '../mcp/candidates';
import { HttpPassiveMcpClient, type PassiveMcpClient } from '../mcp/passive-client';
import { sha256, validateA2a, validateArd } from './validation';

type ProtocolConfig<Summary extends Record<string, unknown>> = { path: string; validate(document: unknown): { validation: NonNullable<DiscoveryResult['validation']>; summary?: Summary } };

function isJsonContentType(value?: string): boolean { return Boolean(value?.split(';', 1)[0]?.trim().match(/^(application|text)\/(?:[a-z0-9.+-]*\+)?json$/i)); }

function retrievalFailure<Summary extends Record<string, unknown>>(url: URL, result: Extract<RetrievalResult, {ok: false}>): DiscoveryResult<Summary> {
  return { status: result.code === 'TARGET_BLOCKED' ? 'blocked' : 'unreachable', discoveryUrl: url.href, finalUrl: result.finalUrl, httpStatus: result.httpStatus, contentType: result.contentType, durationMs: result.durationMs, redirects: result.redirects, warnings: [], error: { code: result.code, message: result.message } };
}

async function inspectOne<Summary extends Record<string, unknown>>(origin: URL, client: SafeOutboundClient, config: ProtocolConfig<Summary>): Promise<DiscoveryResult<Summary>> {
  const url = discoveryUrl(origin, config.path); const retrieved = await client.get(url);
  if (!retrieved.ok) return retrievalFailure<Summary>(url, retrieved);
  const base = { discoveryUrl: url.href, finalUrl: retrieved.finalUrl, httpStatus: retrieved.httpStatus, contentType: retrieved.contentType, bytes: retrieved.body.length, durationMs: retrieved.durationMs, sha256: sha256(retrieved.body), redirects: retrieved.redirects, warnings: isJsonContentType(retrieved.contentType) ? [] : ['CONTENT_TYPE_NOT_JSON'] } as const;
  if (retrieved.httpStatus === 404) return { ...base, status: 'not_found' };
  if (retrieved.httpStatus < 200 || retrieved.httpStatus >= 300) return { ...base, status: 'unreachable', error: { code: 'HTTP_ERROR', message: `Discovery endpoint returned HTTP ${retrieved.httpStatus}.` } };
  let document: unknown;
  try { document = JSON.parse(retrieved.body.toString('utf8')); }
  catch { return { ...base, status: 'invalid', error: { code: 'INVALID_JSON', message: 'Response body is not valid JSON.' } }; }
  const checked = config.validate(document);
  if (!checked.validation.valid) return { ...base, status: 'invalid', validation: checked.validation, error: { code: 'SCHEMA_INVALID', message: 'JSON does not match the pinned protocol schema.' } };
  return { ...base, status: 'valid', validation: checked.validation, summary: checked.summary };
}

export async function inspectOrigin(inputUrl: string, client: SafeOutboundClient = new ConstrainedHttpsClient(), now: () => Date = () => new Date(), mcpEndpoint?: string, mcpClient: PassiveMcpClient = new HttpPassiveMcpClient(client)): Promise<DiscoveryReport> {
  const origin = parsePublicHttpsOrigin(inputUrl);
  const [ard, a2a] = await Promise.all([
    inspectOne<ArdSummary>(origin, client, { path: '/.well-known/ai-catalog.json', validate: validateArd }),
    inspectOne<A2aSummary>(origin, client, { path: '/.well-known/agent-card.json', validate: validateA2a }),
  ]);
  const mcp = await observeMcp(origin, mcpEndpoint, ard.status === 'valid' ? ard.summary?.mcpServerCardUrls ?? [] : [], mcpClient, client);
  return { inputUrl, origin: origin.origin, inspectedAt: now().toISOString(), ard, a2a, mcp };
}
