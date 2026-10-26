import type { WebMcpObservation } from '@interfacedelta/contracts';
import type { SafeOutboundClient } from '../scanner/outbound-boundary';
import { ARD_ROOT_HTML_MAX_BYTES, htmlType } from './ard-html';
import {
  extractWebMcpDeclarativeTools,
  webMcpNotObserved,
} from './webmcp-html';

type SubmittedPageScan = NonNullable<WebMcpObservation['submittedPage']>;
const SCOPE = 'submitted_page_html_declarative_forms' as const;

/**
 * The exact page to scan for a submitted service URL, or undefined when the
 * submitted path is the origin root (already scanned). Only the path is kept:
 * the query can carry per-user tokens and the fragment is never sent.
 */
export function submittedWebMcpPage(
  origin: URL,
  submittedUrl: URL,
): URL | undefined {
  // Resolving the pathname as a reference would read `//host/...` as a new
  // authority; the setter only ever replaces the path. The origin check is
  // defence in depth.
  const page = new URL(origin.origin);
  page.pathname = submittedUrl.pathname;
  return page.origin !== origin.origin || page.pathname === '/'
    ? undefined
    : page;
}

/** One bounded GET of the submitted page; no scripts, forms or links followed. */
export async function scanSubmittedPageForWebMcp(
  origin: URL,
  page: URL,
  client: SafeOutboundClient,
): Promise<SubmittedPageScan> {
  const notObserved = (
    reason: NonNullable<SubmittedPageScan['reason']>,
    finalUrl?: string,
  ) => webMcpNotObserved(page.href, reason, finalUrl, SCOPE);
  let result;
  try {
    result = await client.get(page, {
      maxBodyBytes: ARD_ROOT_HTML_MAX_BYTES,
      accept: 'text/html, application/xhtml+xml',
    });
  } catch {
    return notObserved('unreachable');
  }
  if (!result.ok)
    return notObserved(
      result.code === 'TARGET_BLOCKED'
        ? 'blocked'
        : result.code === 'RESPONSE_TOO_LARGE'
          ? 'response_too_large'
          : 'unreachable',
      result.finalUrl,
    );
  const finalUrl = new URL(result.finalUrl);
  // The submitted page is inspected only on the target's own origin.
  if (finalUrl.origin !== origin.origin)
    return notObserved('cross_origin_redirect', result.finalUrl);
  if (result.httpStatus === 404)
    return notObserved('not_found', result.finalUrl);
  if (result.httpStatus < 200 || result.httpStatus >= 300)
    return notObserved('unreachable', result.finalUrl);
  if (!htmlType(result.contentType))
    return notObserved('not_html', result.finalUrl);
  return extractWebMcpDeclarativeTools(
    result.body.toString('utf8'),
    finalUrl,
    page.href,
    SCOPE,
  );
}
