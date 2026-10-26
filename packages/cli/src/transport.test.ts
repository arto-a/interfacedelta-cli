import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialError } from './errors';
import { localInspector } from './core';
import { CLI_VERSION } from './types';

/**
 * The whole local path on the wire: localInspector, inspectOrigin, the passive
 * MCP client, EndpointCredentialClient and ConstrainedHttpsClient, with only
 * DNS and the socket replaced.
 */
const wire = vi.hoisted(() => ({
  seen: [] as {
    method: string;
    url: string;
    authorization?: string;
    userAgent?: string;
    clientInfo?: unknown;
  }[],
  redirect: false,
}));

vi.mock('@interfacedelta/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@interfacedelta/core')>();
  const json = (value: unknown) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(value)),
  });
  const transport = async (
    url: URL,
    options: { method?: string; headers?: unknown },
    _maxBytes: number,
    _timeoutMs: number,
    body?: Buffer,
  ) => {
    const headers = (options.headers ?? {}) as Record<string, unknown>;
    const method = options.method ?? 'GET';
    const authorization = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === 'authorization',
    )?.[1];
    wire.seen.push({
      method,
      url: url.href,
      ...(authorization ? { authorization: String(authorization) } : {}),
      userAgent: String(headers['user-agent']),
    });
    if (method !== 'POST' || url.pathname === '/elsewhere')
      return { status: 404, headers: {}, body: Buffer.alloc(0) };
    if (wire.redirect)
      return {
        status: 307,
        headers: { location: 'https://mcp.example.com/elsewhere' },
        body: Buffer.alloc(0),
      };
    const message = JSON.parse(body!.toString()) as {
      id?: number;
      method: string;
      params?: { _meta?: Record<string, unknown>; clientInfo?: unknown };
    };
    wire.seen.at(-1)!.clientInfo =
      message.params?.clientInfo ??
      message.params?._meta?.['io.modelcontextprotocol/clientInfo'];
    if (message.id === undefined)
      return { status: 202, headers: {}, body: Buffer.alloc(0) };
    const result =
      message.method === 'server/discover'
        ? {
            supportedVersions: ['2026-07-28'],
            capabilities: { tools: {} },
            _meta: {
              'io.modelcontextprotocol/serverInfo': {
                name: 'Fixture',
                version: '1.0',
              },
            },
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'search',
                  description: 'Find things',
                  inputSchema: { type: 'object' },
                },
              ],
            }
          : {};
    return json({ jsonrpc: '2.0', id: message.id, result });
  };
  class WireClient extends actual.ConstrainedHttpsClient {
    constructor(
      _resolver?: unknown,
      _transport?: unknown,
      options?: ConstructorParameters<typeof actual.ConstrainedHttpsClient>[2],
    ) {
      super(
        async () => [{ address: '93.184.216.34', family: 4 }],
        transport,
        options,
      );
    }
  }
  return { ...actual, ConstrainedHttpsClient: WireClient };
});

const ORIGIN = 'https://mcp.example.com';
const ENDPOINT = 'https://mcp.example.com/mcp';
const TOKEN = 'idt-transport-token.0123456789abcdef';

afterEach(() => {
  wire.seen.length = 0;
  wire.redirect = false;
});

describe('a signed-in inspection on the wire', () => {
  it('sends the token on every POST to the bound endpoint and nowhere else', async () => {
    const passport = await localInspector(ORIGIN, ENDPOINT, null, TOKEN);
    expect(passport.capabilities.map((item) => item.name)).toContain('search');
    const posts = wire.seen.filter((item) => item.method === 'POST');
    const gets = wire.seen.filter((item) => item.method === 'GET');
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(gets.length).toBeGreaterThan(0);
    for (const item of posts) {
      expect(item.url).toBe(ENDPOINT);
      expect(item.authorization).toBe(`Bearer ${TOKEN}`);
    }
    for (const item of gets) expect(item.authorization).toBeUndefined();
  });

  it('names itself as the CLI, not the hosted scanner', async () => {
    await localInspector(ORIGIN, ENDPOINT, null);
    expect(new Set(wire.seen.map((item) => item.userAgent))).toEqual(
      new Set([`InterfaceDelta-CLI/${CLI_VERSION}`]),
    );
    const named = wire.seen.filter((item) => item.clientInfo);
    expect(named.length).toBeGreaterThan(0);
    for (const item of named)
      expect(item.clientInfo).toEqual({
        name: 'InterfaceDelta-CLI',
        version: CLI_VERSION,
      });
  });

  it('sends no credential when no token is bound', async () => {
    await localInspector(ORIGIN, ENDPOINT, null);
    expect(
      wire.seen.filter((item) => item.method === 'POST').length,
    ).toBeGreaterThanOrEqual(2);
    expect(wire.seen.every((item) => !item.authorization)).toBe(true);
  });

  it('drops the token on a redirect and refuses the result', async () => {
    wire.redirect = true;
    await expect(
      localInspector(ORIGIN, ENDPOINT, null, TOKEN),
    ).rejects.toBeInstanceOf(CredentialError);
    const hops = wire.seen.filter((item) => item.url === `${ORIGIN}/elsewhere`);
    expect(hops.length).toBeGreaterThan(0);
    expect(hops.every((item) => !item.authorization)).toBe(true);
  });
});
