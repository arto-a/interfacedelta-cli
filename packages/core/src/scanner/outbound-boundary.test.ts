import { describe, expect, it, vi } from 'vitest';
import type { LookupAddress } from 'node:dns';
import {
  ConstrainedHttpsClient,
  OUTBOUND_LIMITS,
  OutboundPolicyError,
  type Transport,
} from './outbound-boundary';
import type { Resolver } from './target-policy';
import { scriptedHttpsRequest } from './scripted-https.test-support';

// Only the default node transport below reaches node:https; every other test
// injects its own Transport.
const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: https.request }));

const publicResolver: Resolver = async () => [
  { address: '93.184.216.34', family: 4 },
];
const response = (
  status: number,
  headers: Record<string, string> = {},
  body = '{}',
) => ({ status, headers, body: Buffer.from(body) });

describe('constrained HTTPS redirects and bounds', () => {
  it('follows a public HTTPS redirect and passes a lookup pinned to validated DNS', async () => {
    let call = 0;
    const transport: Transport = vi.fn(async (_url, options) => {
      await new Promise<void>((resolve, reject) =>
        options.lookup!(
          'ignored',
          { family: 0, hints: 0, all: false },
          (
            error: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
          ) =>
            error
              ? reject(error)
              : (expect(address).toBe('93.184.216.34'), resolve()),
        ),
      );
      return call++ === 0
        ? response(302, { location: 'https://other.example.com/next' })
        : response(200, { 'content-type': 'application/json' });
    });
    const result = await new ConstrainedHttpsClient(
      publicResolver,
      transport,
    ).get(new URL('https://example.com/start'));
    expect(result).toMatchObject({ ok: true });
    expect(result.redirects).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('blocks a redirect to localhost before a second connection', async () => {
    const transport: Transport = vi.fn(async () =>
      response(302, { location: 'https://localhost/secret' }),
    );
    const result = await new ConstrainedHttpsClient(
      publicResolver,
      transport,
    ).get(new URL('https://example.com/start'));
    expect(result).toMatchObject({ ok: false, code: 'TARGET_BLOCKED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('terminates after three redirects', async () => {
    const transport: Transport = vi.fn(async () =>
      response(302, { location: 'https://example.com/again' }),
    );
    const result = await new ConstrainedHttpsClient(
      publicResolver,
      transport,
    ).get(new URL('https://example.com/start'));
    expect(result).toMatchObject({ ok: false, code: 'REDIRECT_LIMIT' });
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it.each([
    ['TIMEOUT', 'TIMEOUT'],
    ['RESPONSE_TOO_LARGE', 'RESPONSE_TOO_LARGE'],
  ] as const)('normalizes %s transport failure', async (cause, expected) => {
    const transport: Transport = async () => {
      throw Object.assign(new Error(cause), { code: cause });
    };
    await expect(
      new ConstrainedHttpsClient(publicResolver, transport).get(
        new URL('https://example.com'),
      ),
    ).resolves.toMatchObject({ ok: false, code: expected });
  });
  it('pins DNS and preserves a bounded POST body without credentials', async () => {
    const body = Buffer.from('{"jsonrpc":"2.0"}');
    const transport: Transport = vi.fn(
      async (_url, options, _max, _timeout, sent) => {
        expect(sent).toEqual(body);
        expect(options.headers).not.toHaveProperty('authorization');
        await new Promise<void>((resolve, reject) =>
          options.lookup!(
            'ignored',
            { family: 0, hints: 0, all: false },
            (
              error: NodeJS.ErrnoException | null,
              address: string | LookupAddress[],
            ) =>
              error
                ? reject(error)
                : (expect(address).toBe('93.184.216.34'), resolve()),
          ),
        );
        return response(200, { 'content-type': 'application/json' }, '{}');
      },
    );
    await expect(
      new ConstrainedHttpsClient(publicResolver, transport).post(
        new URL('https://example.com/mcp'),
        {
          body,
          headers: { 'content-type': 'application/json' },
          maxBodyBytes: 512 * 1024,
        },
      ),
    ).resolves.toMatchObject({ ok: true });
  });
  it('keeps request-scoped SSE early termination inside the pinned transport path', async () => {
    const body = Buffer.from('{}');
    const stop = vi.fn((bytes: Buffer) => bytes.includes(Buffer.from('\n\n')));
    const transport: Transport = vi.fn(
      async (_url, options, _max, _timeout, _sent, stopAfterBody) => {
        await new Promise<void>((resolve, reject) =>
          options.lookup!(
            'ignored',
            { family: 0, hints: 0, all: false },
            (
              error: NodeJS.ErrnoException | null,
              address: string | LookupAddress[],
            ) =>
              error
                ? reject(error)
                : (expect(address).toBe('93.184.216.34'), resolve()),
          ),
        );
        const first = Buffer.from('data: {"jsonrpc":"2.0"');
        expect(stopAfterBody?.(first, 'text/event-stream')).toBe(false);
        const complete = Buffer.concat([first, Buffer.from('}\n\n')]);
        expect(stopAfterBody?.(complete, 'text/event-stream')).toBe(true);
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: complete,
        };
      },
    );
    await new ConstrainedHttpsClient(publicResolver, transport).post(
      new URL('https://example.com/mcp'),
      { body, headers: {}, maxBodyBytes: 512 * 1024, stopAfterBody: stop },
    );
    expect(transport).toHaveBeenCalledOnce();
  });
  it('blocks an MCP POST redirect to localhost before connection', async () => {
    const transport: Transport = vi.fn(async () =>
      response(307, { location: 'https://localhost/mcp' }),
    );
    const result = await new ConstrainedHttpsClient(
      publicResolver,
      transport,
    ).post(new URL('https://example.com/mcp'), {
      body: Buffer.from('{}'),
      headers: { 'content-type': 'application/json' },
      maxBodyBytes: 512 * 1024,
    });
    expect(result).toMatchObject({ ok: false, code: 'TARGET_BLOCKED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not forward a legacy MCP session identifier across origins', async () => {
    let call = 0;
    const transport: Transport = vi.fn(async (_url, options) => {
      const headers = options.headers as Record<string, string>;
      if (call++ === 0) {
        expect(headers['mcp-session-id']).toBe('private-session');
        return response(307, { location: 'https://other.example.com/mcp' });
      }
      expect(headers['mcp-session-id']).toBeUndefined();
      return response(200, { 'content-type': 'application/json' }, '{}');
    });
    await new ConstrainedHttpsClient(publicResolver, transport).post(
      new URL('https://example.com/mcp'),
      {
        body: Buffer.from('{}'),
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': 'private-session',
        },
        maxBodyBytes: 512 * 1024,
      },
    );
  });
  it('blocks an MCP POST when DNS mixes public and private answers before transport', async () => {
    const resolver: Resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ];
    const transport: Transport = vi.fn();
    const result = await new ConstrainedHttpsClient(resolver, transport).post(
      new URL('https://example.com/mcp'),
      {
        body: Buffer.from('{}'),
        headers: { 'content-type': 'application/json' },
        maxBodyBytes: 512 * 1024,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'TARGET_BLOCKED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('applies a Discovery redirect policy before DNS or transport', async () => {
    const resolver: Resolver = vi.fn(publicResolver);
    const transport: Transport = vi
      .fn<Transport>()
      .mockResolvedValueOnce(
        response(302, { location: 'https://other.example/metadata' }),
      );
    const afterRequest = vi.fn(async () => undefined);
    const result = await new ConstrainedHttpsClient(resolver, transport, {
      boundary: {
        beforeRequest: async ({ url }) => {
          if (url.hostname !== 'example.com')
            throw new OutboundPolicyError('CROSS_HOST_DESTINATION');
          return { requestId: 'reserved' };
        },
        afterRequest,
      },
    }).get(new URL('https://example.com/start'));
    expect(result).toMatchObject({
      ok: false,
      code: 'DISCOVERY_POLICY_LIMITED',
    });
    expect(resolver).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(afterRequest).toHaveBeenCalledOnce();
  });

  it('keeps the ordinary Inspector identity while bot identity is opt-in', async () => {
    const interactive: Transport = vi.fn(async (_url, options) => {
      expect(options.headers).toMatchObject({
        'user-agent': 'InterfaceDelta/0.1',
      });
      return response(200);
    });
    const controlled: Transport = vi.fn(async (_url, options) => {
      expect(options.headers).toMatchObject({
        'user-agent': 'InterfaceDeltaBot/1.0 (+https://interfacedelta.com/bot)',
      });
      return response(200);
    });
    await new ConstrainedHttpsClient(publicResolver, interactive).get(
      new URL('https://example.com/'),
    );
    await new ConstrainedHttpsClient(publicResolver, controlled, {
      userAgent: 'InterfaceDeltaBot/1.0 (+https://interfacedelta.com/bot)',
    }).get(new URL('https://example.com/'));
    expect(interactive).toHaveBeenCalledOnce();
    expect(controlled).toHaveBeenCalledOnce();
  });
});

describe('node transport byte limit', () => {
  const limit = OUTBOUND_LIMITS.maxBodyBytes;
  const oversized = Buffer.alloc(600 * 1024, 'x');
  const serve = (status: number, headers: Record<string, string> = {}) => {
    const scripted = scriptedHttpsRequest(() => ({
      status,
      headers,
      body: oversized,
    }));
    https.request.mockImplementation(scripted.implementation);
    return scripted.requests;
  };

  it('keeps the real status of an oversized error body and stops reading at the limit', async () => {
    const requests = serve(404, { 'content-type': 'text/html' });
    const result = await new ConstrainedHttpsClient(publicResolver).get(
      new URL('https://example.com/.well-known/ard.json'),
    );
    expect(result).toMatchObject({
      ok: true,
      httpStatus: 404,
      contentType: 'text/html',
      truncated: true,
    });
    // Only a short prefix of the error page is kept as context.
    expect(OUTBOUND_LIMITS.maxErrorBodyPrefixBytes).toBeLessThan(limit);
    expect(
      result.ok &&
        result.body.equals(
          oversized.subarray(0, OUTBOUND_LIMITS.maxErrorBodyPrefixBytes),
        ),
    ).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.responseDestroyed).toBe(true);
    expect(requests[0]!.deliveredBytes).toBeLessThan(oversized.length);
  });
  it('still refuses an oversized successful body', async () => {
    serve(200, { 'content-type': 'application/json' });
    await expect(
      new ConstrainedHttpsClient(publicResolver).get(
        new URL('https://example.com/.well-known/ard.json'),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'RESPONSE_TOO_LARGE' });
  });
  it('does not mark an error body that fits the limit as truncated', async () => {
    const scripted = scriptedHttpsRequest(() => ({
      status: 404,
      body: Buffer.alloc(limit, 'x'),
    }));
    https.request.mockImplementation(scripted.implementation);
    const result = await new ConstrainedHttpsClient(publicResolver).get(
      new URL('https://example.com/.well-known/ard.json'),
    );
    expect(result).toMatchObject({ ok: true, httpStatus: 404 });
    expect(result).not.toHaveProperty('truncated');
    expect(result.ok && result.body.length).toBe(limit);
  });
  it('keeps payment challenge headers on an oversized 402 POST', async () => {
    serve(402, {
      'content-type': 'text/html',
      'www-authenticate': 'Payment realm="example"',
      'payment-required': 'eyJ4NDAyVmVyc2lvbiI6Mn0',
    });
    const result = await new ConstrainedHttpsClient(publicResolver).post(
      new URL('https://example.com/mcp'),
      {
        body: Buffer.from('{}'),
        headers: { 'content-type': 'application/json' },
        maxBodyBytes: 64 * 1024,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      httpStatus: 402,
      truncated: true,
      headers: {
        'www-authenticate': 'Payment realm="example"',
        'payment-required': 'eyJ4NDAyVmVyc2lvbiI6Mn0',
      },
    });
    expect(result.ok && result.body.length).toBe(64 * 1024);
  });
  it('keeps robots.txt fail-closed for an oversized error body', async () => {
    serve(404, { 'content-type': 'text/html' });
    const afterRequest = vi.fn(async () => undefined);
    const result = await new ConstrainedHttpsClient(publicResolver, undefined, {
      boundary: {
        beforeRequest: async () => ({ requestId: 'robots' }),
        afterRequest,
      },
    }).get(new URL('https://example.com/robots.txt'), {
      accept: 'text/plain',
      initialRequestKind: 'robots',
    });
    expect(result).toMatchObject({ ok: false, code: 'RESPONSE_TOO_LARGE' });
    expect(afterRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { outcome: 'error', errorCode: 'RESPONSE_TOO_LARGE' },
      }),
    );
  });
});
