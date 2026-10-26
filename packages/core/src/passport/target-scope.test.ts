import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from './canonical-json';
import {
  createMonitoredTargetScope,
  createTargetScope,
  monitoredPagePath,
  MonitoredPageError,
  monitoredPageUrl,
  targetKey,
} from './target-scope';
describe('inspection target scope identity', () => {
  it('normalizes irrelevant origin path, query, fragment, casing and trailing dot', () =>
    expect(
      targetKey(createTargetScope('https://EXAMPLE.com./path?q=1#x')),
    ).toBe(targetKey(createTargetScope('https://example.com/'))));
  it('normalizes equivalent explicit endpoints', () =>
    expect(
      targetKey(
        createTargetScope(
          'https://example.com',
          'https://MCP.example.com:443/api#x',
        ),
      ),
    ).toBe(
      targetKey(
        createTargetScope('https://example.com', 'https://mcp.example.com/api'),
      ),
    ));
  it('separates absent, same-origin, and cross-origin explicit MCP scopes', () => {
    const absent = targetKey(createTargetScope('https://example.com'));
    const same = targetKey(
      createTargetScope('https://example.com', 'https://example.com/mcp'),
    );
    const cross = targetKey(
      createTargetScope(
        'https://example.com',
        'https://vendor.example.org/mcp',
      ),
    );
    expect(new Set([absent, same, cross])).toHaveLength(3);
  });
});

describe('target-scope-v2 page-targets', () => {
  // The exact pre-v2 key derivation, frozen so v1 keys can never drift.
  const legacyKey = (origin: string, mcp: string | null) =>
    `sha256:${canonicalSha256({
      scopeVersion: 'target-scope-v1',
      origin,
      explicitMcpEndpoint: mcp,
    })}`;

  it('keeps every page-less target on its byte-identical v1 key', () => {
    for (const [url, mcp] of [
      ['https://example.com', undefined],
      ['https://example.com/deep/page?q=1', undefined],
      ['https://example.com', 'https://example.com/mcp'],
    ] as const) {
      const v1 = createTargetScope(url, mcp);
      for (const scope of [
        createMonitoredTargetScope(url, mcp),
        createMonitoredTargetScope(url, mcp, null),
      ]) {
        expect(scope).toEqual(v1);
        expect(targetKey(scope)).toBe(targetKey(v1));
        expect(targetKey(scope)).toBe(
          legacyKey(v1.origin, v1.explicitMcpEndpoint),
        );
      }
    }
  });

  it('gives each watched page its own key, distinct from the origin target', () => {
    const origin = targetKey(createTargetScope('https://shop.example.com'));
    const a = targetKey(
      createMonitoredTargetScope('https://shop.example.com', undefined, '/a'),
    );
    const b = targetKey(
      createMonitoredTargetScope('https://shop.example.com', undefined, '/b'),
    );
    expect(new Set([origin, a, b])).toHaveLength(3);
    expect(
      targetKey(
        createMonitoredTargetScope(
          'https://SHOP.example.com./',
          undefined,
          '/a',
        ),
      ),
    ).toBe(a);
  });

  it('pins the submitted path to the origin and drops query and fragment', () => {
    expect(
      monitoredPagePath(
        'https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/?x=1#y',
      ),
    ).toBe('/webmcp-tools/demos/french-bistro/');
    expect(monitoredPagePath('https://shop.example.com/')).toBeNull();
    expect(monitoredPagePath('https://shop.example.com')).toBeNull();
  });

  it.each([
    'https://shop.example.com//evil.com/x',
    'https://shop.example.com/\\evil.com',
    'https://shop.example.com/a/../..//evil.com/y',
  ])('refuses %s instead of leaving the origin', (url) => {
    expect(() => monitoredPagePath(url)).toThrow(MonitoredPageError);
  });

  it('builds the scan URL on the origin and rejects a page the schema forbids', () => {
    const scope = createMonitoredTargetScope(
      'https://shop.example.com',
      undefined,
      '/demos/bistro/',
    );
    expect(monitoredPageUrl(scope)?.href).toBe(
      'https://shop.example.com/demos/bistro/',
    );
    expect(
      monitoredPageUrl(createTargetScope('https://shop.example.com')),
    ).toBe(null);
    for (const page of ['//evil.com/x', '/', 'relative', '/a?b', '/a#b'])
      expect(() =>
        createMonitoredTargetScope('https://shop.example.com', undefined, page),
      ).toThrow();
  });
});
