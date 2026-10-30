import { describe, expect, it, vi } from 'vitest';
import type {
  OutboundPostOptions,
  RetrievalResult,
  SafeOutboundClient,
} from '../scanner/outbound-boundary';
import {
  HttpPassiveMcpClient,
  paymentChallengeResponse,
} from './passive-client';

type Handler = (
  message: Record<string, unknown>,
  options: OutboundPostOptions,
) =>
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | RetrievalResult;
function fake(handler: Handler) {
  const methods: string[] = [];
  const options: OutboundPostOptions[] = [];
  const client: SafeOutboundClient = {
    get: async () => {
      throw new Error('GET forbidden');
    },
    post: vi.fn(
      async (
        url: URL,
        request: OutboundPostOptions,
      ): Promise<RetrievalResult> => {
        options.push(request);
        const message = JSON.parse(request.body.toString()) as Record<
          string,
          unknown
        >;
        methods.push(String(message.method));
        const answer = handler(message, request);
        if ('ok' in answer) return answer;
        const contentType =
          answer.headers?.['content-type'] ?? 'application/json';
        const body = Buffer.from(
          typeof answer.body === 'string' && contentType === 'text/event-stream'
            ? answer.body
            : answer.body === undefined
              ? ''
              : JSON.stringify(answer.body),
        );
        return {
          ok: true,
          httpStatus: answer.status ?? 200,
          body,
          contentType,
          headers: { 'content-type': contentType, ...answer.headers },
          finalUrl: url.href,
          durationMs: 2,
          redirects: [],
        };
      },
    ),
  };
  return { client, methods, options };
}
const success = (
  message: Record<string, unknown>,
  result: Record<string, unknown>,
) => ({ jsonrpc: '2.0', id: message.id, result });
const discoverResult = {
  supportedVersions: ['2026-07-28'],
  capabilities: { tools: {}, resources: {}, prompts: {} },
  instructions: 'untrusted instructions',
  _meta: {
    'io.modelcontextprotocol/serverInfo': {
      name: 'Fixture Server',
      version: '2.0',
    },
  },
};

describe('passive MCP client', () => {
  it('discovers modern identity/capabilities and lists metadata without active operations', async () => {
    const f = fake((message) => {
      const method = String(message.method);
      if (method === 'server/discover')
        return { body: success(message, discoverResult) };
      if (method === 'tools/list')
        return {
          body: success(message, {
            tools: [
              {
                name: 'search',
                title: 'Search',
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                  title: 'Declared title',
                },
                description: 'Find things',
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
              },
            ],
          }),
        };
      if (method === 'resources/list')
        return {
          body: success(message, {
            resources: [
              {
                uri: 'data:text/plain,no-fetch',
                name: 'Public index',
                mimeType: 'text/plain',
              },
            ],
          }),
        };
      return {
        body: success(message, {
          prompts: [{ name: 'review', arguments: [{ name: 'text' }] }],
        }),
      };
    });
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'valid',
      protocol: { era: 'modern', version: '2026-07-28' },
      server: { selfReportedIdentity: { name: 'Fixture Server' } },
      tools: {
        count: 1,
        items: [
          {
            publisherDeclarations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
              title: 'Declared title',
            },
            inputSchemaCompatibility: {
              projectionVersion: 'json-schema-compatibility-projection-v1',
              limitations: [],
            },
            outputSchemaCompatibility: {
              projectionVersion: 'json-schema-compatibility-projection-v1',
              limitations: [],
            },
          },
        ],
      },
      resources: { count: 1 },
      prompts: { count: 1 },
    });
    expect(f.methods).toEqual([
      'server/discover',
      'tools/list',
      'resources/list',
      'prompts/list',
    ]);
    expect(
      f.methods.every((method) =>
        [
          'server/discover',
          'tools/list',
          'resources/list',
          'prompts/list',
        ].includes(method),
      ),
    ).toBe(true);
    expect(
      f.options.every(
        (option) =>
          !('authorization' in option.headers) && !('cookie' in option.headers),
      ),
    ).toBe(true);
    const discover = JSON.parse(f.options[0]!.body.toString());
    expect(discover.params._meta).toMatchObject({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    });
  });
  it('does not list unadvertised capabilities and permits absent server identity', async () => {
    const f = fake((message) => ({
      body: success(message, {
        supportedVersions: ['2026-07-28'],
        capabilities: {},
      }),
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(f.methods).toEqual(['server/discover']);
    expect(result).toMatchObject({
      status: 'valid',
      tools: { attempted: false, reason: 'not_advertised' },
      server: { instructionsPresent: false },
    });
  });
  it('falls back only on MCP method-not-found and completes the legacy lifecycle', async () => {
    const f = fake((message) => {
      switch (message.method) {
        case 'server/discover':
          return {
            body: {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'Method not found' },
            },
          };
        case 'initialize':
          return {
            headers: { 'mcp-session-id': 'session-1' },
            body: success(message, {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'Legacy', version: '1' },
            }),
          };
        case 'notifications/initialized':
          return { status: 202 };
        default:
          return { body: success(message, { tools: [] }) };
      }
    });
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'valid',
      protocol: {
        era: 'legacy',
        version: '2025-11-25',
        legacyInitializeAttempted: true,
      },
    });
    expect(f.methods).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(f.options[3]!.headers['mcp-session-id']).toBe('session-1');
  });
  it('falls back to legacy initialization when pre-initialization discovery returns HTTP 400', async () => {
    const f = fake((message) => {
      switch (message.method) {
        case 'server/discover':
          return { status: 400, body: { error: 'initialize first' } };
        case 'initialize':
          return {
            headers: { 'mcp-session-id': 'session-after-400' },
            body: success(message, {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'Legacy after 400', version: '1' },
            }),
          };
        case 'notifications/initialized':
          return { status: 202 };
        default:
          return {
            body: success(message, {
              tools: [
                { name: 'documented_tool', inputSchema: { type: 'object' } },
              ],
            }),
          };
      }
    });
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'valid',
      protocol: {
        era: 'legacy',
        fallbackReason:
          'server/discover returned HTTP 400 before initialization',
        legacyInitializeAttempted: true,
      },
      tools: { attempted: true, complete: true, count: 1 },
    });
    expect(f.methods).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    expect(f.methods).not.toContain('tools/call');
  });
  it('falls back once: a 400 from legacy initialize too ends the inspection', async () => {
    const f = fake(() => ({ status: 400, body: {} }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.status).toBe('unreachable');
    expect(f.methods).toEqual(['server/discover', 'initialize']);
  });
  it.each([
    [402, 'payment_required'],
    [401, 'auth_required'],
    [403, 'forbidden'],
    [404, 'not_mcp'],
    [500, 'unreachable'],
  ] as const)(
    'does not fall back when discovery returns HTTP %s',
    async (status, expected) => {
      const f = fake(() => ({ status, body: {} }));
      const result = await new HttpPassiveMcpClient(f.client).inspect(
        new URL('https://example.com/mcp'),
        ['user_supplied'],
      );
      expect(result.status).toBe(expected);
      expect(f.methods).toEqual(['server/discover']);
    },
  );
  it('handles request-scoped SSE during supported legacy initialization', async () => {
    const f = fake((message) => {
      if (message.method === 'server/discover')
        return {
          body: {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          },
        };
      if (message.method === 'initialize')
        return {
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'legacy-sse',
          },
          body: `data: {"jsonrpc":"2.0","method":"notifications/message"}\n\ndata: ${JSON.stringify(success(message, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'Legacy SSE', version: '1' } }))}\n\n`,
        };
      return { status: 202 };
    });
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'valid',
      protocol: { era: 'legacy', version: '2025-11-25' },
    });
    expect(f.methods).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
    ]);
  });
  it('does not fallback for unrelated HTTP failure', async () => {
    const f = fake(() => ({ status: 500, body: 'failure' }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.status).toBe('unreachable');
    expect(f.methods).toEqual(['server/discover']);
  });
  it('rejects a malformed legacy initialize response', async () => {
    const f = fake((message) =>
      message.method === 'server/discover'
        ? {
            body: {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'Method not found' },
            },
          }
        : {
            body: success(message, {
              protocolVersion: '2025-11-25',
              capabilities: {},
            }),
          },
    );
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'protocol_error',
      error: { code: 'MALFORMED_INITIALIZE_RESULT' },
    });
    expect(f.methods).toEqual(['server/discover', 'initialize']);
  });
  it.each([
    [
      'malformed JSON-RPC',
      () => ({ status: 200, body: 'not-json' }),
      'not_mcp',
    ],
    [
      'wrong response id',
      (message: Record<string, unknown>) => ({
        body: { jsonrpc: '2.0', id: `wrong-${message.id}`, result: {} },
      }),
      'protocol_error',
    ],
    [
      'JSON-RPC error',
      (message: Record<string, unknown>) => ({
        body: {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: 'bad' },
        },
      }),
      'protocol_error',
    ],
  ] as const)('handles %s', (_label, answer, status) => {
    return (async () => {
      const f = fake((message) => answer(message));
      const result = await new HttpPassiveMcpClient(f.client).inspect(
        new URL('https://example.com/mcp'),
        ['user_supplied'],
      );
      expect(result.status).toBe(status);
    })();
  });
  it('reports unsupported legacy negotiation', async () => {
    const f = fake((message) =>
      message.method === 'server/discover'
        ? {
            body: success(message, {
              supportedVersions: ['2027-01-01'],
              capabilities: {},
            }),
          }
        : {
            body: success(message, {
              protocolVersion: '2026-07-28',
              capabilities: {},
              serverInfo: { name: 'x', version: '1' },
            }),
          },
    );
    expect(
      (
        await new HttpPassiveMcpClient(f.client).inspect(
          new URL('https://example.com/mcp'),
          ['user_supplied'],
        )
      ).status,
    ).toBe('unsupported_version');
  });
  describe('MCP Apps declarations (ext-apps specification/2026-01-26)', () => {
    const inspectTools = async (
      tools: unknown[],
      resources: unknown[] = [],
    ) => {
      const f = fake((message) => {
        const method = String(message.method);
        if (method === 'server/discover')
          return { body: success(message, discoverResult) };
        if (method === 'tools/list')
          return { body: success(message, { tools }) };
        if (method === 'resources/list')
          return { body: success(message, { resources }) };
        return { body: success(message, { prompts: [] }) };
      });
      const result = await new HttpPassiveMcpClient(f.client).inspect(
        new URL('https://example.com/mcp'),
        ['user_supplied'],
      );
      return { result, methods: f.methods };
    };
    const tool = (meta?: unknown) => ({
      name: 'get_weather',
      description: 'Get current weather for a location',
      inputSchema: { type: 'object' },
      ...(meta === undefined ? {} : { _meta: meta }),
    });

    it('records the spec example tool UI reference and visibility without reading it', async () => {
      const { result, methods } = await inspectTools(
        [
          tool({
            ui: {
              resourceUri: 'ui://weather-server/dashboard-template',
              visibility: ['model', 'app'],
            },
          }),
        ],
        [
          {
            uri: 'ui://weather-server/dashboard-template',
            name: 'Weather Dashboard',
            mimeType: 'text/html;profile=mcp-app',
          },
        ],
      );
      expect(result.tools?.items[0]).toMatchObject({
        uiResourceUri: 'ui://weather-server/dashboard-template',
        uiResourceUriField: 'ui.resourceUri',
        uiVisibility: ['model', 'app'],
      });
      expect(result.resources?.items[0]).toMatchObject({
        uri: 'ui://weather-server/dashboard-template',
        mimeType: 'text/html;profile=mcp-app',
      });
      expect(methods).not.toContain('resources/read');
      expect(methods).toEqual([
        'server/discover',
        'tools/list',
        'resources/list',
        'prompts/list',
      ]);
    });
    it('records an app-only visibility declaration verbatim', async () => {
      const { result } = await inspectTools([
        tool({
          ui: {
            resourceUri: 'ui://weather-server/dashboard-template',
            visibility: ['app'],
          },
        }),
      ]);
      expect(result.tools?.items[0]?.uiVisibility).toEqual(['app']);
    });
    it('reads the deprecated flat ui/resourceUri key and prefers the nested field', async () => {
      const { result } = await inspectTools([
        tool({ 'ui/resourceUri': 'ui://legacy/view' }),
        {
          ...tool({
            ui: { resourceUri: 'ui://new/view' },
            'ui/resourceUri': 'ui://legacy/view',
          }),
          name: 'both',
        },
      ]);
      expect(result.tools?.items[0]).toMatchObject({
        uiResourceUri: 'ui://legacy/view',
        uiResourceUriField: 'ui/resourceUri',
      });
      expect(result.tools?.items[1]).toMatchObject({
        uiResourceUri: 'ui://new/view',
        uiResourceUriField: 'ui.resourceUri',
      });
    });
    it('treats an empty nested resourceUri as absent without falling back to the flat key', async () => {
      const { result } = await inspectTools([
        tool({ ui: { resourceUri: '' }, 'ui/resourceUri': 'ui://legacy/view' }),
      ]);
      expect(result.tools?.items[0]?.uiResourceUri).toBeUndefined();
      expect(result.tools?.items[0]?.uiResourceUriField).toBeUndefined();
    });
    it('adds no UI keys for tools without a declaration, an empty URI, or non-string values', async () => {
      const { result } = await inspectTools([
        tool(),
        { ...tool({ ui: { resourceUri: '' } }), name: 'empty' },
        { ...tool({ ui: { resourceUri: 42 } }), name: 'number' },
      ]);
      for (const item of result.tools!.items) {
        expect(item.uiResourceUri).toBeUndefined();
        expect(item.uiResourceUriField).toBeUndefined();
        expect(item.uiVisibility).toBeUndefined();
        expect(JSON.parse(JSON.stringify(item))).not.toHaveProperty(
          'uiResourceUri',
        );
      }
    });
    it('bounds declared visibility values and drops non-strings', async () => {
      const { result } = await inspectTools([
        tool({
          ui: {
            resourceUri: `ui://x/${'a'.repeat(3_000)}`,
            visibility: [1, 'model', 'x'.repeat(100), ...Array(10).fill('app')],
          },
        }),
      ]);
      const item = result.tools!.items[0]!;
      expect(item.uiResourceUri).toHaveLength(2_000);
      expect(item.uiVisibility).toHaveLength(8);
      expect(item.uiVisibility![0]).toBe('model');
      expect(item.uiVisibility![1]).toHaveLength(40);
    });
  });
  it('strips C0, DEL and C1 control characters from WWW-Authenticate', async () => {
    const f = fake(() => ({
      status: 401,
      headers: {
        'www-authenticate': 'Bearer\u0007 realm="a"\u007f\u0085\u009f ok\u00a0',
      },
      body: {},
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.auth?.wwwAuthenticate).toBe('Bearer realm="a" ok\u00a0');
  });
  it('strips bidi controls from WWW-Authenticate', async () => {
    const f = fake(() => ({
      status: 401,
      headers: {
        'www-authenticate':
          'Bearer realm="\u202egnp.exe\u202c" \u2066x\u2069\u200e\u200f\u061c',
      },
      body: {},
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.auth?.wwwAuthenticate).toBe('Bearer realm="gnp.exe" x');
  });
  it('maps HTTP 401 to auth_required without following auth metadata', async () => {
    const header = 'Bearer realm="public"';
    const f = fake(() => ({
      status: 401,
      headers: { 'www-authenticate': header },
      body: {},
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'auth_required',
      auth: { httpStatus: 401, wwwAuthenticate: header },
    });
    expect(f.methods).toHaveLength(1);
  });
  it('maps HTTP 403 to forbidden and records insufficient scope factually', async () => {
    const header = 'Bearer realm="restricted", error="insufficient_scope"';
    const f = fake(() => ({
      status: 403,
      headers: { 'www-authenticate': header },
      body: {},
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'forbidden',
      auth: {
        httpStatus: 403,
        wwwAuthenticate: header,
        insufficientScope: true,
      },
    });
    expect(f.methods).toHaveLength(1);
  });
  it('maps HTTP 402 to payment_required without offering payment', async () => {
    const header = 'Payment id="abc", realm="api", method="x"';
    const f = fake(() => ({
      status: 402,
      headers: { 'www-authenticate': header },
      body: { x402Version: 1, accepts: [] },
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'payment_required',
      auth: {
        httpStatus: 402,
        wwwAuthenticate: header,
        insufficientScope: false,
      },
    });
    expect(result.error).toBeUndefined();
    expect(f.methods).toEqual(['server/discover']);
    const sent = Object.keys(f.options[0]!.headers ?? {}).map((name) =>
      name.toLowerCase(),
    );
    expect(sent).not.toContain('accept-payment');
    expect(sent).not.toContain('authorization');
    expect(sent.some((name) => name.includes('payment'))).toBe(false);
  });
  it('bounds a multi-byte 402 content type to 200 UTF-8 bytes on whole code points', async () => {
    const contentType = `application/json; note=${'é😀'.repeat(60)}`;
    const f = fake(() => ({
      status: 402,
      headers: { 'content-type': contentType },
      body: { x402Version: 2, accepts: [] },
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    const stored = result.paymentChallenge!.contentType!;
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(200);
    expect(contentType.startsWith(stored)).toBe(true);
    expect(stored).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it('parses the first-contact 402 body into a hashed, declared-only challenge', async () => {
    const body = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0xasset',
          payTo: '0xpayee',
          maxAmountRequired: '5000',
        },
      ],
    };
    const f = fake(() => ({ status: 402, body }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    const evidence = result.network!.responses[0]!;
    expect(result.paymentChallenge).toMatchObject({
      bodySha256: evidence.sha256,
      bodyBytes: evidence.bytes,
      contentType: 'application/json',
      observation: {
        surface: 'http_402_x402_body',
        httpStatus: 402,
        resource: 'https://example.com/mcp',
        settlementObserved: false,
        deliveryObserved: false,
        requirements: [
          expect.objectContaining({
            scheme: 'exact',
            maxAmountRequired: '5000',
          }),
        ],
      },
    });
    expect(f.methods).toEqual(['server/discover']);
  });
  it('keeps a challenge from the header when the 402 body is not UTF-8', async () => {
    const f = fake(() => ({
      ok: true,
      httpStatus: 402,
      body: Buffer.from([0xff, 0xfe, 0xfd]),
      contentType: 'application/json',
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Payment realm="api"',
      },
      finalUrl: 'https://example.com/mcp',
      durationMs: 1,
      redirects: [],
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.status).toBe('payment_required');
    expect(result.paymentChallenge?.observation.rawChallengeHeader).toBe(
      'Payment realm="api"',
    );
    expect(result.paymentChallenge?.bodyBytes).toBe(3);
  });
  it('reads the x402 v2 PAYMENT-REQUIRED header beside an empty body', async () => {
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '5000',
            asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            payTo: '0x2222222222222222222222222222222222222222',
          },
        ],
      }),
    ).toString('base64');
    const f = fake(() => ({
      status: 402,
      headers: { 'payment-required': header },
      body: {},
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.status).toBe('payment_required');
    expect(result.paymentChallenge?.observation).toMatchObject({
      surface: 'http_402_x402_header',
      declaredProtocolVersion: '2',
      rejections: [],
      requirements: [
        expect.objectContaining({
          payTo: '0x2222222222222222222222222222222222222222',
          evidencePath: '$.headers["payment-required"].accepts[0]',
        }),
      ],
    });
    // Reading a header of the response already received sends nothing.
    expect(f.methods).toEqual(['server/discover']);
    const sent = Object.keys(f.options[0]!.headers ?? {}).map((name) =>
      name.toLowerCase(),
    );
    expect(sent.some((name) => name.includes('payment'))).toBe(false);
  });
  it('keeps the Passport header at 512 characters and the challenge header whole', async () => {
    const header = `Payment id="abc", realm="api", request="${'e'.repeat(2_000)}"`;
    const f = fake(() => ({
      status: 402,
      headers: { 'www-authenticate': header },
      body: {},
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.auth?.wwwAuthenticate).toBe(header.slice(0, 512));
    expect(result.paymentChallenge?.observation.rawChallengeHeader).toBe(
      header,
    );
  });
  it('reports a challenge header past the bound as not retained', async () => {
    const header = `Payment request="${'e'.repeat(9_000)}"`;
    const f = fake(() => ({
      status: 402,
      headers: {
        'content-type': 'text/plain',
        'www-authenticate': header,
      },
      body: 'payment required',
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.auth?.wwwAuthenticate).toHaveLength(512);
    expect(result.paymentChallenge?.observation).toMatchObject({
      surface: 'http_402_www_authenticate',
      rawChallengeHeader: null,
    });
  });
  it('never parses a truncated 402 body, and keeps no record of it', async () => {
    const envelope = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        accepts: [{ scheme: 'exact', payTo: '0xprefix' }],
      }),
    );
    const truncated = {
      ok: true as const,
      httpStatus: 402,
      body: envelope,
      contentType: 'application/json',
      headers: {
        'content-type': 'application/json',
        'payment-required': Buffer.from(
          JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact' }] }),
        ).toString('base64'),
      },
      finalUrl: 'https://example.com/mcp',
      durationMs: 1,
      redirects: [],
      truncated: true as const,
    };
    // No record presents the prefix hash and size as the body's. The
    // complete header is lost with it, by design.
    const f = fake(() => truncated);
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.status).toBe('payment_required');
    expect(result.paymentChallenge).toBeUndefined();
    // The same bytes, complete, are read.
    const whole: typeof truncated = { ...truncated };
    delete (whole as { truncated?: true }).truncated;
    const complete = fake(() => whole);
    expect(
      (
        await new HttpPassiveMcpClient(complete.client).inspect(
          new URL('https://example.com/mcp'),
          ['user_supplied'],
        )
      ).paymentChallenge?.observation.surface,
    ).toBe('http_402_x402_header');
    expect(
      paymentChallengeResponse(truncated, 'application/json', undefined)
        .bodyText,
    ).toBe(envelope.toString('utf8'));
  });
  it('still reports payment_required when the 402 carries an empty challenge header', async () => {
    // An empty WWW-Authenticate previously threw out of inspect(), so a
    // publisher could fail every inspection and monitor run of its target.
    // A control-only value sanitizes to empty.
    for (const header of ['', '\u0001']) {
      const f = fake(() => ({
        status: 402,
        headers: { 'www-authenticate': header },
        body: { x402Version: 1, accepts: [] },
      }));
      const result = await new HttpPassiveMcpClient(f.client).inspect(
        new URL('https://example.com/mcp'),
        ['user_supplied'],
      );
      expect(result.status).toBe('payment_required');
      expect(
        result.paymentChallenge?.observation.rawChallengeHeader,
      ).toBeNull();
    }
  });
  it('reads a valid v2 header beside an empty challenge header', async () => {
    const f = fake(() => ({
      status: 402,
      headers: {
        'www-authenticate': '',
        'payment-required': Buffer.from(
          JSON.stringify({
            x402Version: 2,
            accepts: [{ scheme: 'exact', payTo: '0xpayee' }],
          }),
        ).toString('base64'),
      },
      body: {},
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.paymentChallenge?.observation).toMatchObject({
      surface: 'http_402_x402_header',
      rawChallengeHeader: null,
      requirements: [expect.objectContaining({ payTo: '0xpayee' })],
    });
  });
  it('maps a bare HTTP 402 without a challenge header to payment_required', async () => {
    const f = fake(() => ({ status: 402, body: {} }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.status).toBe('payment_required');
    expect(result.auth).toEqual({
      httpStatus: 402,
      wwwAuthenticate: undefined,
      insufficientScope: false,
    });
  });
  it('records HTTP 402 during inventory as an incomplete group, not a status change', async () => {
    const f = fake((message) => {
      const method = String(message.method);
      if (method === 'server/discover')
        return { body: success(message, discoverResult) };
      if (method === 'tools/list') return { status: 402, body: {} };
      return { body: success(message, { [method.split('/')[0]!]: [] }) };
    });
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.status).toBe('truncated');
    expect(result.auth).toBeUndefined();
    expect(result.tools).toMatchObject({
      attempted: true,
      complete: false,
      failureCode: 'PAYMENT_REQUIRED',
    });
    expect(result.resources?.complete).toBe(true);
  });
  it.each([
    ['TIMEOUT', 'unreachable'],
    ['RESPONSE_TOO_LARGE', 'unreachable'],
  ] as const)('normalizes %s', async (code, status) => {
    const f = fake(() => ({
      ok: false,
      code,
      message: code,
      durationMs: 1,
      redirects: [],
    }));
    expect(
      (
        await new HttpPassiveMcpClient(f.client).inspect(
          new URL('https://example.com/mcp'),
          ['user_supplied'],
        )
      ).status,
    ).toBe(status);
  });
  it.each([
    ['repeated_cursor', 'repeat', 2],
    ['page_limit', 'unique', 5],
    ['item_limit', 'items', 1],
    ['malformed_result', 'malformed', 1],
    ['malformed_result', 'cursor', 1],
  ] as const)(
    'reports %s pagination truncation',
    async (reason, mode, expectedPages) => {
      let page = 0;
      const f = fake((message) => {
        if (message.method === 'server/discover')
          return {
            body: success(message, {
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
            }),
          };
        page++;
        if (mode === 'items')
          return {
            body: success(message, {
              tools: Array.from({ length: 1000 }, (_, i) => ({
                name: `t${i}`,
                inputSchema: { type: 'object' },
              })),
            }),
          };
        if (mode === 'malformed')
          return { body: success(message, { tools: 'bad' }) };
        if (mode === 'cursor')
          return { body: success(message, { tools: [], nextCursor: 42 }) };
        return {
          body: success(message, {
            tools: [],
            nextCursor: mode === 'repeat' ? 'same' : `p${page}`,
          }),
        };
      });
      const result = await new HttpPassiveMcpClient(f.client).inspect(
        new URL('https://example.com/mcp'),
        ['user_supplied'],
      );
      expect(result).toMatchObject({
        status: 'truncated',
        tools: {
          complete: false,
          truncatedReason: reason,
          pages: expectedPages,
        },
      });
    },
  );
  it('handles normal multi-page final pagination and cache metadata', async () => {
    let page = 0;
    const f = fake((message) =>
      message.method === 'server/discover'
        ? {
            body: success(message, {
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
            }),
          }
        : {
            body: success(message, {
              tools: [{ name: `t${++page}`, inputSchema: { type: 'object' } }],
              ...(page === 1 ? { nextCursor: 'next' } : {}),
              ttlMs: 100,
              cacheScope: 'public',
            }),
          },
    );
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'valid',
      tools: {
        count: 2,
        complete: true,
        pages: 2,
        cache: [
          { ttlMs: 100, scope: 'public' },
          { ttlMs: 100, scope: 'public' },
        ],
      },
    });
  });
  it('parses a bounded SSE JSON-RPC response event', async () => {
    const client: SafeOutboundClient = {
      get: async () => {
        throw new Error('GET forbidden');
      },
      post: async (url, request) => {
        const message = JSON.parse(request.body.toString());
        const payload = success(message, {
          supportedVersions: ['2026-07-28'],
          capabilities: {},
        });
        const body = Buffer.from(
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
        return {
          ok: true,
          httpStatus: 200,
          body,
          contentType: 'text/event-stream',
          headers: { 'content-type': 'text/event-stream' },
          finalUrl: url.href,
          durationMs: 1,
          redirects: [],
        };
      },
    };
    expect(
      (
        await new HttpPassiveMcpClient(client).inspect(
          new URL('https://example.com/mcp'),
          ['user_supplied'],
        )
      ).status,
    ).toBe('valid');
  });
  it('skips bounded SSE notifications and completes on the matching response', async () => {
    const f = fake((message) => {
      const notification = (method: string) =>
        `data: ${JSON.stringify({ jsonrpc: '2.0', method, params: { message: 'untrusted' } })}\r\n\r\n`;
      return {
        headers: { 'content-type': 'text/event-stream' },
        body: `: keepalive\r\nretry: 1000\r\n\r\n${notification('notifications/progress')}${notification('notifications/message')}${notification('notifications/progress')}data: ${JSON.stringify(success(message, { supportedVersions: ['2026-07-28'], capabilities: {} }))}\r\n\r\n`,
      };
    });
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.status).toBe('valid');
    expect(f.methods).toEqual(['server/discover']);
  });
  it('requires the matching response after SSE notifications', async () => {
    const f = fake(() => ({
      headers: { 'content-type': 'text/event-stream' },
      body: 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'protocol_error',
      error: { code: 'SSE_RESPONSE_MISSING' },
    });
    expect(f.methods).toHaveLength(1);
  });
  it('rejects wrong-id and interactive SSE messages without answering', async () => {
    for (const body of [
      'data: {"jsonrpc":"2.0","id":"other","result":{}}\n\n',
      'data: {"jsonrpc":"2.0","id":"server-1","method":"sampling/createMessage","params":{}}\n\n',
    ]) {
      const f = fake(() => ({
        headers: { 'content-type': 'text/event-stream' },
        body,
      }));
      const result = await new HttpPassiveMcpClient(f.client).inspect(
        new URL('https://example.com/mcp'),
        ['user_supplied'],
      );
      expect(result.status).toBe('protocol_error');
      expect(f.methods).toEqual(['server/discover']);
    }
  });
  it('rejects SSE event overflow before any matching response', async () => {
    const body = Array.from(
      { length: 65 },
      () => `data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n`,
    ).join('');
    const f = fake(() => ({
      headers: { 'content-type': 'text/event-stream' },
      body,
    }));
    expect(
      await new HttpPassiveMcpClient(f.client).inspect(
        new URL('https://example.com/mcp'),
        ['user_supplied'],
      ),
    ).toMatchObject({
      status: 'protocol_error',
      error: { code: 'SSE_EVENT_LIMIT' },
    });
  });
  it('enforces the total endpoint byte budget across pages', async () => {
    let page = 0;
    const padding = 'x'.repeat(430_000);
    const f = fake((message) =>
      message.method === 'server/discover'
        ? {
            body: success(message, {
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
            }),
          }
        : {
            body: success(message, {
              tools: [],
              padding,
              nextCursor: `p${++page}`,
            }),
          },
    );
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result).toMatchObject({
      status: 'truncated',
      tools: { complete: false, truncatedReason: 'byte_limit' },
    });
  });
  it('does not mark a complete 402 body as truncated', async () => {
    const f = fake(() => ({
      status: 402,
      body: { x402Version: 2, accepts: [] },
    }));
    const result = await new HttpPassiveMcpClient(f.client).inspect(
      new URL('https://example.com/mcp'),
      ['user_supplied'],
    );
    expect(result.network!.responses[0]).not.toHaveProperty('truncated');
    expect(result.paymentChallenge).toBeDefined();
  });
  it('drops an unserializable challenge record but keeps the inspection', async () => {
    // A ~20 KB body nested 10,000 deep passes extraction but overflowed the
    // stack when the observation was serialized for storage.
    const nested = '['.repeat(10_000) + ']'.repeat(10_000);
    const bodyText = `{"x402Version":1,"accepts":[{"scheme":"exact","z":${nested}}]}`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const f = fake(() => ({
        ok: true,
        httpStatus: 402,
        body: Buffer.from(bodyText),
        contentType: 'application/json',
        headers: { 'content-type': 'application/json' },
        finalUrl: 'https://example.com/mcp',
        durationMs: 2,
        redirects: [],
      }));
      const result = await new HttpPassiveMcpClient(f.client).inspect(
        new URL('https://example.com/mcp'),
        ['user_supplied'],
      );
      expect(result.status).toBe('payment_required');
      expect(result.paymentChallenge).toBeUndefined();
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        'Payment challenge extraction failed',
        expect.objectContaining({ code: 'PAYMENT_CHALLENGE_EXTRACT_FAILED' }),
      );
    } finally {
      warn.mockRestore();
    }
  });
  it('records no challenge from a truncated 402 body and marks its evidence as a prefix', async () => {
    // A valid x402 envelope larger than the response cap: only its first
    // bytes arrive, which no longer parse as JSON.
    const envelope = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            payTo: '0xpayee',
            maxAmountRequired: '1',
            description: 'x'.repeat(600 * 1024),
          },
        ],
      }),
    );
    for (const header of [undefined, 'Payment realm="api"']) {
      const prefix = envelope.subarray(0, 64 * 1024);
      const f = fake(() => ({
        ok: true,
        httpStatus: 402,
        body: prefix,
        contentType: 'application/json',
        headers: {
          'content-type': 'application/json',
          ...(header ? { 'www-authenticate': header } : {}),
        },
        finalUrl: 'https://example.com/mcp',
        durationMs: 1,
        redirects: [],
        truncated: true,
      }));
      const result = await new HttpPassiveMcpClient(f.client).inspect(
        new URL('https://example.com/mcp'),
        ['user_supplied'],
      );
      expect(result.status).toBe('payment_required');
      // Neither a body_not_valid_utf8_json rejection nor the prefix's hash
      // and length presented as the body's.
      expect(result.paymentChallenge).toBeUndefined();
      expect(result.auth).toEqual({
        httpStatus: 402,
        wwwAuthenticate: header,
        insufficientScope: false,
      });
      expect(result.network!.responses[0]).toMatchObject({
        httpStatus: 402,
        bytes: prefix.length,
        truncated: true,
      });
    }
  });
});
