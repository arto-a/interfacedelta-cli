import { Parser } from 'htmlparser2';
import type { SafeOutboundClient } from '../scanner/outbound-boundary';
import { parsePublicHttpsEndpoint } from '../scanner/target-policy';
import type { WebMcpObservation } from '@interfacedelta/contracts';
import {
  extractWebMcpDeclarativeTools,
  webMcpNotObserved,
} from './webmcp-html';

export const ARD_ROOT_HTML_MAX_BYTES = 128 * 1024;
export const ARD_REL_LINK_LIMIT = 4;
export type ArdLinkDiscovery = {
  rootUrl: string;
  finalUrl?: string;
  status: 'parsed' | 'not_found' | 'unreachable' | 'blocked' | 'not_html';
  links: string[];
  totalLinks: number;
  truncated: boolean;
  errorCode?: string;
  /** Declarative WebMCP forms found in the same root HTML response. */
  webmcp: WebMcpObservation;
};

export const htmlType = (value?: string) =>
  Boolean(
    value
      ?.split(';', 1)[0]
      ?.trim()
      .match(/^(text\/html|application\/xhtml\+xml)$/i),
  );
export async function discoverArdLinks(
  origin: URL,
  client: SafeOutboundClient,
): Promise<ArdLinkDiscovery> {
  const root = new URL('/', origin);
  let result;
  try {
    result = await client.get(root, {
      maxBodyBytes: ARD_ROOT_HTML_MAX_BYTES,
      accept: 'text/html, application/xhtml+xml',
    });
  } catch {
    return {
      rootUrl: root.href,
      status: 'unreachable',
      links: [],
      totalLinks: 0,
      truncated: false,
      errorCode: 'CONNECTION_ERROR',
      webmcp: webMcpNotObserved(root.href, 'unreachable'),
    };
  }
  if (!result.ok)
    return {
      rootUrl: root.href,
      finalUrl: result.finalUrl,
      status: result.code === 'TARGET_BLOCKED' ? 'blocked' : 'unreachable',
      links: [],
      totalLinks: 0,
      truncated: false,
      errorCode: result.code,
      webmcp: webMcpNotObserved(
        root.href,
        result.code === 'TARGET_BLOCKED'
          ? 'blocked'
          : result.code === 'RESPONSE_TOO_LARGE'
            ? 'response_too_large'
            : 'unreachable',
        result.finalUrl,
      ),
    };
  if (result.httpStatus === 404)
    return {
      rootUrl: root.href,
      finalUrl: result.finalUrl,
      status: 'not_found',
      links: [],
      totalLinks: 0,
      truncated: false,
      webmcp: webMcpNotObserved(root.href, 'not_found', result.finalUrl),
    };
  if (result.httpStatus < 200 || result.httpStatus >= 300)
    return {
      rootUrl: root.href,
      finalUrl: result.finalUrl,
      status: 'unreachable',
      links: [],
      totalLinks: 0,
      truncated: false,
      errorCode: 'HTTP_ERROR',
      webmcp: webMcpNotObserved(root.href, 'unreachable', result.finalUrl),
    };
  if (!htmlType(result.contentType))
    return {
      rootUrl: root.href,
      finalUrl: result.finalUrl,
      status: 'not_html',
      links: [],
      totalLinks: 0,
      truncated: false,
      errorCode: 'CONTENT_TYPE_NOT_HTML',
      webmcp: webMcpNotObserved(root.href, 'not_html', result.finalUrl),
    };
  const raw: string[] = [];
  let headDepth = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase();
        if (tag === 'head') headDepth++;
        if (tag !== 'link' || headDepth === 0) return;
        const rel = attributes.rel;
        if (
          !rel ||
          !rel
            .split(/[\t\n\f\r ]+/)
            .some((token) => token.toLowerCase() === 'ard')
        )
          return;
        const href = attributes.href?.trim();
        if (href) raw.push(href);
      },
      onclosetag(name) {
        if (name.toLowerCase() === 'head' && headDepth > 0) headDepth--;
      },
    },
    {
      decodeEntities: true,
      lowerCaseAttributeNames: true,
      lowerCaseTags: true,
      recognizeSelfClosing: true,
    },
  );
  const html = result.body.toString('utf8');
  parser.end(html);
  const base = new URL(result.finalUrl);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const href of raw) {
    try {
      const url = parsePublicHttpsEndpoint(new URL(href, base).href);
      if (!seen.has(url.href)) {
        seen.add(url.href);
        unique.push(url.href);
      }
    } catch {
      /* invalid/private-policy syntax is ignored here; DNS policy runs on fetch */
    }
  }
  return {
    rootUrl: root.href,
    finalUrl: result.finalUrl,
    status: 'parsed',
    links: unique.slice(0, ARD_REL_LINK_LIMIT),
    totalLinks: unique.length,
    truncated: unique.length > ARD_REL_LINK_LIMIT,
    webmcp: extractWebMcpDeclarativeTools(html, base, root.href),
  };
}
