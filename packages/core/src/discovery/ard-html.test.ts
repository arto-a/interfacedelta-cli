import { describe, expect, it, vi } from 'vitest';
import type {
  RetrievalResult,
  SafeOutboundClient,
} from '../scanner/outbound-boundary';
import {
  ARD_REL_LINK_LIMIT,
  ARD_ROOT_HTML_MAX_BYTES,
  discoverArdLinks,
} from './ard-html';
const response = (
  url: URL,
  body: string,
  contentType = 'text/html',
): RetrievalResult => ({
  ok: true,
  httpStatus: 200,
  body: Buffer.from(body),
  contentType,
  headers: { 'content-type': contentType },
  finalUrl: url.href,
  durationMs: 1,
  redirects: [],
});
describe('bounded rel=ard root discovery', () => {
  it('honours relative href and ASCII case/token semantics in head only', async () => {
    const get = vi.fn(async (url: URL, options) => {
      expect(options).toEqual({
        maxBodyBytes: ARD_ROOT_HTML_MAX_BYTES,
        accept: 'text/html, application/xhtml+xml',
      });
      return response(
        url,
        '<html><head><link rel="alternate ARD metadata" href="./entries.json"><script src="/x.js"></script></head><body><link rel="ard" href="/ignored.json"><img src="/x.png"><a href="/ordinary">x</a></body></html>',
      );
    });
    const found = await discoverArdLinks(new URL('https://example.com/path'), {
      get,
      post: vi.fn(),
    } as SafeOutboundClient);
    expect(found.links).toEqual(['https://example.com/entries.json']);
    expect(get).toHaveBeenCalledOnce();
  });
  it('deduplicates, bounds fan-out, and reports truncation under malformed HTML', async () => {
    const links = Array.from(
      { length: ARD_REL_LINK_LIMIT + 2 },
      (_, i) => `<link REL="ard" href="/ard-${i}.json">`,
    ).join('');
    const found = await discoverArdLinks(new URL('https://example.com'), {
      get: async (url) => response(url, `<html><head>${links}${links}`),
      post: vi.fn(),
    } as SafeOutboundClient);
    expect(found.links).toHaveLength(ARD_REL_LINK_LIMIT);
    expect(found.totalLinks).toBe(ARD_REL_LINK_LIMIT + 2);
    expect(found.truncated).toBe(true);
  });
  it('resolves relative links against the validated final root URL', async () => {
    const found = await discoverArdLinks(new URL('https://example.com'), {
      get: async (url) => ({
        ...response(
          url,
          '<html><head><link rel="ard" href="./manifest.json"></head></html>',
        ),
        finalUrl: 'https://www.example.org/base/',
      }),
      post: vi.fn(),
    } as SafeOutboundClient);
    expect(found.links).toEqual(['https://www.example.org/base/manifest.json']);
  });
  it('rejects syntactically forbidden targets without fetching them', async () => {
    const found = await discoverArdLinks(new URL('https://example.com'), {
      get: async (url) =>
        response(
          url,
          '<head><link rel="ard" href="https://localhost/private"><link rel="ard" href="http://example.com/insecure">',
        ),
      post: vi.fn(),
    } as SafeOutboundClient);
    expect(found.links).toEqual([]);
  });
  it('reads declarative WebMCP forms from the same single root response', async () => {
    const get = vi.fn(async (url: URL) =>
      response(
        url,
        '<html><head><link rel="ard" href="/a.json"></head><body><form toolname="search" action="https://other.example/s"><input name="q"></form></body></html>',
      ),
    );
    const post = vi.fn();
    const found = await discoverArdLinks(
      new URL('https://example.com/deep/page'),
      {
        get,
        post,
      } as SafeOutboundClient,
    );
    expect(get).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
    expect(found.links).toEqual(['https://example.com/a.json']);
    expect(found.webmcp).toMatchObject({
      status: 'observed',
      sourceUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      tools: [
        {
          name: 'search',
          actionRelationship: 'cross_origin',
          action: 'https://other.example/s',
        },
      ],
    });
  });
  it.each([
    [
      {
        ok: false,
        code: 'RESPONSE_TOO_LARGE',
        message: 'x',
        durationMs: 1,
        redirects: [],
      },
      'response_too_large',
    ],
    [
      {
        ok: false,
        code: 'TARGET_BLOCKED',
        message: 'x',
        durationMs: 1,
        redirects: [],
      },
      'blocked',
    ],
    [
      {
        ok: false,
        code: 'TIMEOUT',
        message: 'x',
        durationMs: 1,
        redirects: [],
      },
      'unreachable',
    ],
  ] as const)(
    'marks WebMCP not observed when the root fetch fails (%#)',
    async (failure, reason) => {
      const found = await discoverArdLinks(new URL('https://example.com'), {
        get: async () => failure as RetrievalResult,
        post: vi.fn(),
      } as SafeOutboundClient);
      expect(found.webmcp).toMatchObject({
        status: 'not_observed',
        reason,
        tools: [],
      });
    },
  );
  it('marks WebMCP not observed for 404 and non-HTML roots', async () => {
    const notFound = await discoverArdLinks(new URL('https://example.com'), {
      get: async (url) => ({ ...response(url, ''), httpStatus: 404 }),
      post: vi.fn(),
    } as SafeOutboundClient);
    expect(notFound.webmcp).toMatchObject({
      status: 'not_observed',
      reason: 'not_found',
    });
    const json = await discoverArdLinks(new URL('https://example.com'), {
      get: async (url) =>
        response(url, '<form toolname="x"></form>', 'application/json'),
      post: vi.fn(),
    } as SafeOutboundClient);
    expect(json.webmcp).toMatchObject({
      status: 'not_observed',
      reason: 'not_html',
      tools: [],
    });
  });
});
