import { describe, expect, it, vi } from 'vitest';
import {
  ConstrainedHttpsClient,
  type Transport,
} from '../scanner/outbound-boundary';
import type { Resolver } from '../scanner/target-policy';
import { EndpointCredentialClient, isBearerToken } from './endpoint-credential';

const publicResolver: Resolver = async () => [
  { address: '93.184.216.34', family: 4 },
];
const endpoint = new URL('https://mcp.example.com/mcp');
const post = { body: Buffer.from('{}'), headers: {}, maxBodyBytes: 1024 };

function recording(responses: { status: number; location?: string }[]) {
  const seen: { url: string; authorization?: unknown }[] = [];
  let call = 0;
  const transport: Transport = vi.fn(async (url, options) => {
    seen.push({
      url: url.href,
      authorization: (options.headers as Record<string, unknown>).authorization,
    });
    const next = responses[Math.min(call++, responses.length - 1)]!;
    return {
      status: next.status,
      headers: next.location
        ? { location: next.location }
        : { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    };
  });
  return {
    seen,
    client: new ConstrainedHttpsClient(publicResolver, transport),
  };
}

describe('endpoint-scoped bearer credential', () => {
  it('is sent only on POSTs to the exact endpoint', async () => {
    const { seen, client } = recording([{ status: 200 }]);
    const credentialed = new EndpointCredentialClient(
      client,
      endpoint,
      'abc.123',
    );
    await credentialed.post(endpoint, post);
    await credentialed.post(new URL('https://mcp.example.com/mcp/'), post);
    await credentialed.post(new URL('https://mcp.example.com/other'), post);
    await credentialed.get(endpoint);
    expect(seen.map((item) => item.authorization)).toEqual([
      'Bearer abc.123',
      undefined,
      undefined,
      undefined,
    ]);
    expect(credentialed.sent).toBe(true);
  });

  it('is dropped on every redirect hop, same origin or not', async () => {
    for (const location of [
      'https://mcp.example.com/mcp2',
      'https://elsewhere.example.com/mcp',
    ]) {
      const { seen, client } = recording([
        { status: 307, location },
        { status: 200 },
      ]);
      await new EndpointCredentialClient(client, endpoint, 'abc').post(
        endpoint,
        post,
      );
      expect(seen).toEqual([
        { url: endpoint.href, authorization: 'Bearer abc' },
        { url: location, authorization: undefined },
      ]);
    }
    // The caller learns the answer came from a hop without the token.
    const { client } = recording([
      { status: 307, location: 'https://mcp.example.com/mcp/' },
      { status: 200 },
    ]);
    const credentialed = new EndpointCredentialClient(client, endpoint, 'abc');
    await credentialed.post(endpoint, post);
    expect(credentialed.redirectedTo).toBe('https://mcp.example.com/mcp/');
  });

  it('never lets ordinary request headers carry it across a redirect either', async () => {
    const { seen, client } = recording([
      { status: 307, location: 'https://elsewhere.example.com/x' },
      { status: 200 },
    ]);
    await client.post(endpoint, {
      ...post,
      credentialHeaders: { authorization: 'Bearer abc' },
    });
    expect(seen[1]!.authorization).toBeUndefined();
  });

  it('accepts only RFC 6750 bearer tokens', () => {
    for (const token of ['ghp_abc123', 'sk_test_51Ab', 'a.b-c~d+e/f=='])
      expect(isBearerToken(token)).toBe(true);
    for (const token of ['', 'a b', 'a\nb', 'tök', 'a'.repeat(4097)])
      expect(isBearerToken(token)).toBe(false);
    expect(
      () => new EndpointCredentialClient({} as never, endpoint, 'bad token'),
    ).toThrow('not a valid bearer token');
  });
});
