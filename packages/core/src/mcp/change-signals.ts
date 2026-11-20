import type {
  McpChangeSignals,
  OAuthDynamicRegistration,
} from '@interfacedelta/contracts';
import { parsePublicHttpsEndpoint } from '../scanner/target-policy';
import type { RetrievalResult } from '../scanner/outbound-boundary';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function observeListChanges(
  capabilities: Record<string, unknown> | undefined,
): McpChangeSignals {
  const state = (name: string) => {
    if (!capabilities) return 'not_observed' as const;
    const value = object(capabilities[name])?.listChanged;
    return value === true
      ? ('yes' as const)
      : value === false || value === undefined
        ? ('no' as const)
        : ('not_observed' as const);
  };
  return {
    version: 'mcp-change-signals-v1',
    tools: state('tools'),
    prompts: state('prompts'),
    resources: state('resources'),
  };
}

/** At most two same-origin metadata GETs. No endpoint guessing, redirects, credentials,
 * registration POSTs, or retained metadata bodies/URLs. The caller owns shared budgets.
 * Cross-origin issuers require a separately authorized robots policy and remain unknown. */
export async function observeDynamicRegistration(
  endpoint: URL,
  challenge: string | undefined,
  get: (url: URL) => Promise<RetrievalResult | undefined>,
): Promise<OAuthDynamicRegistration> {
  const result = (
    declared: OAuthDynamicRegistration['declared'],
  ): OAuthDynamicRegistration => ({
    version: 'oauth-dynamic-registration-v1',
    declared,
  });
  const sameOrigin = (raw: unknown) => {
    if (typeof raw !== 'string' || raw.length > 2048) return undefined;
    try {
      if (new URL(raw).hash) return undefined;
      const url = parsePublicHttpsEndpoint(raw);
      return url.origin === endpoint.origin && !url.search && !url.hash
        ? url
        : undefined;
    } catch {
      return undefined;
    }
  };
  const read = async (url: URL) => {
    const response = await get(url);
    if (
      !response?.ok ||
      response.httpStatus !== 200 ||
      response.truncated ||
      response.redirects.length ||
      response.finalUrl !== url.href ||
      !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(
        response.contentType ?? response.headers['content-type'] ?? '',
      )
    )
      return undefined;
    return object(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(response.body),
      ),
    );
  };
  try {
    const links = [
      ...(challenge ?? '').matchAll(/\bresource_metadata\s*=\s*"([^"\\]+)"/gi),
    ];
    if (links.length !== 1) return result('not_observed');
    const resourceUrl = sameOrigin(links[0]?.[1]);
    if (!resourceUrl) return result('not_observed');
    const resource = await read(resourceUrl);
    // Do not treat a partial multi-issuer observation as a negative declaration.
    if (
      resource?.resource !== endpoint.href ||
      !Array.isArray(resource.authorization_servers) ||
      resource.authorization_servers.length !== 1
    )
      return result('not_observed');
    const issuer = sameOrigin(resource.authorization_servers[0]);
    if (!issuer) return result('not_observed');
    const metadataUrl = new URL(
      `/.well-known/oauth-authorization-server${issuer.pathname === '/' ? '' : issuer.pathname}`,
      issuer,
    );
    const metadata = await read(metadataUrl);
    if (!metadata || metadata.issuer !== resource.authorization_servers[0])
      return result('not_observed');
    if (!Object.hasOwn(metadata, 'registration_endpoint')) return result('no');
    if (typeof metadata.registration_endpoint !== 'string')
      return result('not_observed');
    // Validate the declaration, but never fetch or retain the endpoint (even its path).
    parsePublicHttpsEndpoint(metadata.registration_endpoint);
    return result('yes');
  } catch {
    return result('not_observed');
  }
}
