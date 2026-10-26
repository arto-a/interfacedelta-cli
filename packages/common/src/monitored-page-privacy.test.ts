import { describe, expect, it } from 'vitest';
import {
  monitoredPageCredentialReason,
  monitoredPageLooksUnguessable,
} from './monitored-page-privacy';
import { MonitoredPageError, monitoredPagePath } from './target-scope';

describe('monitored page privacy', () => {
  it.each([
    '/share/token=abc123',
    '/portal;jsessionid=ABCDEF0123',
    '/files/X-Amz-Signature=deadbeef',
    '/api/api_key=secret',
    '/reset/password=hunter2',
    '/oauth/access_token=abc',
    '/client/client_secret=abc',
    '/a/b&sig=1',
    '/jwt/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
  ])('refuses %s', (path) => {
    expect(monitoredPageCredentialReason(path)).toMatch(/shareable history/);
    expect(() => monitoredPagePath(`https://example.com${path}`)).toThrow(
      MonitoredPageError,
    );
  });

  it.each([
    '/pricing',
    '/docs/agents/webmcp',
    '/orders/3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b',
    '/tokens',
    '/design-tokens/colors',
    '/filter/color=red',
    '/signature-pad',
    '/session/overview',
    '/blog/2026/09/eyjafjallajokull',
  ])('accepts %s', (path) => {
    expect(monitoredPageCredentialReason(path)).toBeNull();
    expect(monitoredPagePath(`https://example.com${path}`)).toBe(path);
  });

  it('only cautions for random-looking segments', () => {
    const capability = '/share/9f3c2a7b4e1d8c6f5a0b3e2d1c4f7a8b';
    expect(monitoredPageLooksUnguessable(capability)).toBe(true);
    expect(monitoredPageLooksUnguessable('/s/aB3dE5fG7hJ9kL1mN2pQ')).toBe(true);
    expect(monitoredPagePath(`https://example.com${capability}`)).toBe(
      capability,
    );
    for (const path of [
      '/pricing',
      '/docs/agents/webmcp',
      '/blog/2026/09/launch-notes',
    ])
      expect(monitoredPageLooksUnguessable(path)).toBe(false);
  });
});
