import type { InspectionUrlType } from '@interfacedelta/contracts';

export type ResolvedInspectionUrlType = Exclude<InspectionUrlType, 'auto'>;

const withoutTrailingSlash = (pathname: string) =>
  pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

/**
 * Classifies only deterministic, reviewed URL path conventions.
 *
 * Auto deliberately falls back to service discovery. Content-looking names or
 * arbitrary paths do not authorize protocol requests; the explicit type
 * control is the escape hatch for nonstandard endpoints.
 */
export function resolveInspectionUrlType(
  url: URL,
  requested: InspectionUrlType,
): ResolvedInspectionUrlType {
  if (requested !== 'auto') return requested;

  const pathname = withoutTrailingSlash(url.pathname.toLowerCase());
  if (
    pathname.endsWith('/.well-known/ard.json') ||
    pathname.endsWith('/.well-known/ai-catalog.json')
  )
    return 'ard';
  if (pathname.endsWith('/.well-known/agent-card.json')) return 'a2a';
  if (pathname === '/mcp' || pathname.endsWith('/mcp')) return 'mcp';

  const filename = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (
    /^(?:openapi|swagger)(?:[-._][a-z0-9-]+)*\.(?:json|ya?ml)$/.test(filename)
  )
    return 'openapi';

  return 'service';
}
