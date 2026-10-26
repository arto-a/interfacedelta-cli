import { describe, expect, it } from 'vitest';
import type {
  RetrievalResult,
  SafeOutboundClient,
} from '../scanner/outbound-boundary';
import { ARD_ROOT_HTML_MAX_BYTES } from './ard-html';
import { scanSubmittedPageForWebMcp, submittedWebMcpPage } from './webmcp-page';

const origin = new URL('https://shop.example');
const page = new URL('https://shop.example/checkout');
const ok = (
  body: string,
  contentType = 'text/html',
  finalUrl = page.href,
  httpStatus = 200,
): RetrievalResult => ({
  ok: true,
  httpStatus,
  body: Buffer.from(body),
  contentType,
  headers: { 'content-type': contentType },
  finalUrl,
  durationMs: 1,
  redirects: [],
});
const client = (
  answer: RetrievalResult | (() => never),
  seen: { url: string; maxBodyBytes?: number }[] = [],
): SafeOutboundClient => ({
  get: async (url, options) => {
    seen.push({ url: url.href, maxBodyBytes: options?.maxBodyBytes });
    return typeof answer === 'function' ? answer() : answer;
  },
  post: async () => {
    throw new Error('POST is never used');
  },
});

describe('submitted-page WebMCP scan', () => {
  it('keeps only the path and skips the origin root', () => {
    expect(
      submittedWebMcpPage(origin, new URL('https://shop.example/a/b?x=1#y'))
        ?.href,
    ).toBe('https://shop.example/a/b');
    expect(
      submittedWebMcpPage(origin, new URL('https://shop.example/?x=1')),
    ).toBeUndefined();
  });

  it.each([
    ['https://shop.example//evil.com/x', 'https://shop.example//evil.com/x'],
    ['https://shop.example/\\evil.com', 'https://shop.example//evil.com'],
    [
      'https://shop.example/a/../..//evil.com/y',
      'https://shop.example//evil.com/y',
    ],
    [
      'https://shop.example/%2F%2Fevil.com',
      'https://shop.example/%2F%2Fevil.com',
    ],
  ])('pins %s to the validated origin', (submitted, expected) => {
    const page = submittedWebMcpPage(origin, new URL(submitted));
    expect(page?.href).toBe(expected);
    expect(page?.origin).toBe(origin.origin);
  });
  it('covers a demo that lives below the origin root (synthetic fixture)', async () => {
    const demoOrigin = new URL('https://googlechromelabs.github.io');
    const demo = submittedWebMcpPage(
      demoOrigin,
      new URL(
        'https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/',
      ),
    )!;
    expect(demo.href).toBe(
      'https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/',
    );
    // Synthetic markup in the documented declarative shape, not the demo's bytes.
    const seen: { url: string; maxBodyBytes?: number }[] = [];
    const scan = await scanSubmittedPageForWebMcp(
      demoOrigin,
      demo,
      client(
        ok(
          '<form toolname="book_table" tooldescription="Reserve a table"><input name="guests" type="number" required toolparamdescription="Party size"></form>',
          'text/html',
          demo.href,
        ),
        seen,
      ),
    );
    expect(scan).toMatchObject({
      scope: 'submitted_page_html_declarative_forms',
      status: 'observed',
      tools: [{ name: 'book_table' }],
    });
    expect(seen).toEqual([
      { url: demo.href, maxBodyBytes: ARD_ROOT_HTML_MAX_BYTES },
    ]);
  });

  it('does not read HTML after a redirect to another origin', async () => {
    const scan = await scanSubmittedPageForWebMcp(
      origin,
      page,
      client(
        ok(
          '<form toolname="steal"></form>',
          'text/html',
          'https://other.example/checkout',
        ),
      ),
    );
    expect(scan).toMatchObject({
      status: 'not_observed',
      reason: 'cross_origin_redirect',
      tools: [],
    });
  });

  it.each([
    [ok('{"a":1}', 'application/json'), 'not_html'],
    [ok('', 'text/html', page.href, 404), 'not_found'],
    [ok('', 'text/html', page.href, 500), 'unreachable'],
    [
      {
        ok: false,
        code: 'RESPONSE_TOO_LARGE',
        message: 'too large',
        durationMs: 1,
        redirects: [],
      } satisfies RetrievalResult,
      'response_too_large',
    ],
    [
      {
        ok: false,
        code: 'TARGET_BLOCKED',
        message: 'blocked',
        durationMs: 1,
        redirects: [],
      } satisfies RetrievalResult,
      'blocked',
    ],
  ] as const)('reports %#: %s without tools', async (answer, reason) => {
    const scan = await scanSubmittedPageForWebMcp(origin, page, client(answer));
    expect(scan).toMatchObject({ status: 'not_observed', reason, tools: [] });
  });

  it('reports a thrown request as unreachable', async () => {
    const scan = await scanSubmittedPageForWebMcp(
      origin,
      page,
      client(() => {
        throw new Error('boom');
      }),
    );
    expect(scan).toMatchObject({
      status: 'not_observed',
      reason: 'unreachable',
    });
  });
});
