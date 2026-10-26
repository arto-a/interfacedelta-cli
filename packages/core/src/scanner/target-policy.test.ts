import { describe, expect, it } from 'vitest';
import {
  assertAllAddressesPublic,
  parsePublicHttpsEndpoint,
  parsePublicHttpsOrigin,
  validateAndResolve,
  type ResolvedAddress,
} from './target-policy';

describe('public target policy', () => {
  it.each([
    'http://example.com',
    'https://localhost',
    'https://localhost:443',
    'https://127.0.0.1',
    'https://[::1]',
    'https://user:password@example.com',
    'https://example.com:8443',
    'https://service.internal',
    'https://name.test',
  ])('rejects %s', (input) =>
    expect(() => parsePublicHttpsOrigin(input)).toThrow(),
  );
  it('canonicalizes path, query, fragment, case, and default port to an origin', () =>
    expect(
      parsePublicHttpsOrigin('https://Example.COM:443/path?q=1#x').href,
    ).toBe('https://example.com/'));
  it('retains an explicit MCP endpoint path and query but removes its fragment', () =>
    expect(
      parsePublicHttpsEndpoint(
        'https://Example.com:443/mcp/v1?tenant=public#ignored',
      ).href,
    ).toBe('https://example.com/mcp/v1?tenant=public'));
  it.each([
    ['10.0.0.1', 4],
    ['127.0.0.1', 4],
    ['169.254.1.1', 4],
    ['100.64.0.1', 4],
    ['::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['::ffff:10.0.0.1', 6],
  ] as const)('blocks non-public DNS answer %s', (address, family) =>
    expect(() => assertAllAddressesPublic([{ address, family }])).toThrow(
      /non-public/,
    ),
  );
  it('blocks mixed public and private DNS answers', () =>
    expect(() =>
      assertAllAddressesPublic([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    ).toThrow(/non-public/));
  it('accepts only-public injected DNS answers', async () => {
    const answers: ResolvedAddress[] = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    await expect(
      validateAndResolve(
        new URL('https://example.com/path'),
        async () => answers,
      ),
    ).resolves.toEqual(answers);
  });
});
