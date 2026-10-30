import { z } from 'zod';
import { canonicalSha256 } from './canonical-json';
import { monitoredPageCredentialReason } from './monitored-page-privacy';
import {
  parsePublicHttpsEndpoint,
  parsePublicHttpsOrigin,
} from './outbound-policy';

export const TARGET_SCOPE_VERSION = 'target-scope-v1' as const;
/** A monitored target that also watches one same-origin page. */
export const PAGE_TARGET_SCOPE_VERSION = 'target-scope-v2' as const;
/** A direct protocol document, independent of other documents on its host. */
export const DOCUMENT_TARGET_SCOPE_VERSION = 'target-scope-v3' as const;
export const MONITORED_PAGE_MAX_LENGTH = 2048;

export const targetScopeSchema = z
  .object({
    scopeVersion: z.literal(TARGET_SCOPE_VERSION),
    origin: z.string().url(),
    explicitMcpEndpoint: z.string().url().nullable(),
  })
  .strict();

export type TargetScope = z.infer<typeof targetScopeSchema>;

export class MonitoredPageError extends Error {
  readonly code = 'MONITORED_PAGE_INVALID';
}

/**
 * Pins a submitted URL's path to its origin: the page path, or null for the
 * root. The `pathname` setter never changes the authority, so `//host`,
 * `/\host` and `/a/../..//host` stay on the origin; a result still beginning
 * `//` is refused so no later relative resolution can read it as a new host.
 */
export function monitoredPagePath(inputUrl: string): string | null {
  const origin = parsePublicHttpsOrigin(inputUrl);
  const submitted = parsePublicHttpsEndpoint(inputUrl);
  const page = new URL(origin.origin);
  page.pathname = submitted.pathname;
  if (page.origin !== origin.origin)
    throw new MonitoredPageError('The monitored page must stay on the origin.');
  if (page.pathname === '/') return null;
  if (page.pathname.startsWith('//'))
    throw new MonitoredPageError(
      'A monitored page path must not begin with //.',
    );
  if (page.pathname.length > MONITORED_PAGE_MAX_LENGTH)
    throw new MonitoredPageError('The monitored page path is too long.');
  const credential = monitoredPageCredentialReason(page.pathname);
  if (credential) throw new MonitoredPageError(credential);
  return page.pathname;
}

const monitoredPageSchema = z
  .string()
  .max(MONITORED_PAGE_MAX_LENGTH)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      value !== '/' &&
      !value.includes('?') &&
      !value.includes('#'),
    'A monitored page is a same-origin path other than the root.',
  );

export const pageTargetScopeSchema = z
  .object({
    scopeVersion: z.literal(PAGE_TARGET_SCOPE_VERSION),
    origin: z.string().url(),
    explicitMcpEndpoint: z.string().url().nullable(),
    monitoredPage: monitoredPageSchema,
  })
  .strict();

export type PageTargetScope = z.infer<typeof pageTargetScopeSchema>;
export const monitoredDocumentSchema = z
  .object({
    path: monitoredPageSchema.refine((path) => {
      try {
        return monitoredPagePath(`https://scope.example.com${path}`) === path;
      } catch {
        return false;
      }
    }, 'A monitored document must have a safe, canonical same-origin path.'),
    type: z.enum(['openapi', 'a2a', 'ard']),
  })
  .strict();
export type MonitoredDocument = z.infer<typeof monitoredDocumentSchema>;
export const documentTargetScopeSchema = z
  .object({
    scopeVersion: z.literal(DOCUMENT_TARGET_SCOPE_VERSION),
    origin: z.string().url(),
    explicitMcpEndpoint: z.string().url().nullable(),
    monitoredDocument: monitoredDocumentSchema,
  })
  .strict();
export type DocumentTargetScope = z.infer<typeof documentTargetScopeSchema>;
export type MonitoredTargetScope =
  TargetScope | PageTargetScope | DocumentTargetScope;

export const monitoredTargetScopeSchema = z.discriminatedUnion('scopeVersion', [
  targetScopeSchema,
  pageTargetScopeSchema,
  documentTargetScopeSchema,
]);

export function createTargetScope(
  inputUrl: string,
  explicitMcpEndpoint?: string,
): TargetScope {
  return targetScopeSchema.parse({
    scopeVersion: TARGET_SCOPE_VERSION,
    origin: parsePublicHttpsOrigin(inputUrl).origin,
    explicitMcpEndpoint: explicitMcpEndpoint
      ? parsePublicHttpsEndpoint(explicitMcpEndpoint).href
      : null,
  });
}

/**
 * A v1 scope when no page is watched, so page-less targets keep their exact
 * existing key; a v2 scope only when a non-root page is present; v3 when a
 * document path and protocol are present. This also reconstructs worker claims.
 */
export function createMonitoredTargetScope(
  inputUrl: string,
  explicitMcpEndpoint?: string,
  monitoredPage?: string | null,
  monitoredDocument?: MonitoredDocument | null,
): MonitoredTargetScope {
  const base = createTargetScope(inputUrl, explicitMcpEndpoint);
  if (monitoredDocument) {
    if (monitoredPage)
      throw new MonitoredPageError(
        'A document target cannot also watch a page.',
      );
    return documentTargetScopeSchema.parse({
      ...base,
      scopeVersion: DOCUMENT_TARGET_SCOPE_VERSION,
      monitoredDocument,
    });
  }
  if (monitoredPage === undefined || monitoredPage === null) return base;
  return pageTargetScopeSchema.parse({
    ...base,
    scopeVersion: PAGE_TARGET_SCOPE_VERSION,
    monitoredPage,
  });
}

export function createDocumentTargetScope(
  inputUrl: string,
  type: MonitoredDocument['type'],
  explicitMcpEndpoint?: string,
): DocumentTargetScope {
  const path = monitoredPagePath(inputUrl);
  return documentTargetScopeSchema.parse({
    ...createTargetScope(inputUrl, explicitMcpEndpoint),
    scopeVersion: DOCUMENT_TARGET_SCOPE_VERSION,
    monitoredDocument: { path, type },
  });
}

export const scopeMonitoredDocument = (scope: MonitoredTargetScope) =>
  scope.scopeVersion === DOCUMENT_TARGET_SCOPE_VERSION
    ? scope.monitoredDocument
    : null;

/** Uses the pathname setter so a stored path can never replace the authority. */
export function monitoredDocumentUrl(scope: MonitoredTargetScope): URL | null {
  const document = scopeMonitoredDocument(scope);
  if (!document) return null;
  const url = parsePublicHttpsOrigin(scope.origin);
  url.pathname = monitoredDocumentSchema.parse(document).path;
  return url;
}

export const scopeMonitoredPage = (scope: MonitoredTargetScope) =>
  scope.scopeVersion === PAGE_TARGET_SCOPE_VERSION ? scope.monitoredPage : null;

/** The URL a page-target scan submits: the watched page pinned to the origin. */
export function monitoredPageUrl(scope: MonitoredTargetScope): URL | null {
  const path = scopeMonitoredPage(scope);
  if (!path) return null;
  const page = new URL(scope.origin);
  page.pathname = path;
  return page.origin === new URL(scope.origin).origin ? page : null;
}

export function targetKey(scope: MonitoredTargetScope): string {
  const value = monitoredTargetScopeSchema.parse(scope);
  return `sha256:${canonicalSha256(
    value.scopeVersion === DOCUMENT_TARGET_SCOPE_VERSION
      ? {
          scopeVersion: value.scopeVersion,
          origin: value.origin,
          explicitMcpEndpoint: value.explicitMcpEndpoint,
          monitoredDocument: value.monitoredDocument,
        }
      : value.scopeVersion === PAGE_TARGET_SCOPE_VERSION
        ? {
            scopeVersion: value.scopeVersion,
            origin: value.origin,
            explicitMcpEndpoint: value.explicitMcpEndpoint,
            monitoredPage: value.monitoredPage,
          }
        : {
            scopeVersion: value.scopeVersion,
            origin: value.origin,
            explicitMcpEndpoint: value.explicitMcpEndpoint,
          },
  )}`;
}
