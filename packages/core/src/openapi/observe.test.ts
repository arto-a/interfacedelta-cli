import { describe, expect, it, vi } from 'vitest';
import type { ArdSummary } from '@interfacedelta/contracts';
import type { SafeOutboundClient } from '../scanner/outbound-boundary';
import {
  isOpenApiMediaType,
  observeOpenApi,
  OPENAPI_LIMITS,
  parseAndNormalizeOpenApi,
} from './observe';

const declaration = {
  identifier: 'urn:air:example.com:openapi:public',
  displayName: 'Example API',
  type: 'application/vnd.oai.openapi+json;version=3.1',
  url: 'https://example.com/openapi.json',
};
const summary = (
  entry: ArdSummary['declarations'][number] = declaration,
): ArdSummary => ({
  specVersion: 'v0.91',
  entries: 1,
  entryTypes: [entry.type],
  hostPresent: false,
  mcpServerCardUrls: [],
  openApiUrls: entry.url ? [entry.url] : [],
  declarations: [entry],
});
const valid = (extra: Record<string, unknown> = {}) => ({
  openapi: '3.1.2',
  info: { title: 'Example', version: '1.0.0' },
  servers: [{ url: 'https://example.com' }],
  paths: {
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { $ref: '#/components/schemas/Id' },
          },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
  components: { schemas: { Id: { type: 'string', minLength: 1 } } },
  ...extra,
});
const response = (body: string, contentType = 'application/json') => ({
  ok: true as const,
  body: Buffer.from(body),
  httpStatus: 200,
  contentType,
  finalUrl: declaration.url!,
  durationMs: 1,
  redirects: [],
  headers: {},
});
const client = (body: string, contentType?: string): SafeOutboundClient => ({
  get: vi.fn(async () => response(body, contentType)),
  post: vi.fn(),
});

describe('OpenAPI observation', () => {
  it('recognizes only the exact reviewed OpenAPI media type family', () => {
    expect(isOpenApiMediaType(declaration.type)).toBe(true);
    expect(
      isOpenApiMediaType('application/vnd.oai.openapi+yaml;version=3.1'),
    ).toBe(true);
    expect(isOpenApiMediaType('application/swagger+json')).toBe(false);
    expect(isOpenApiMediaType('text/openapi')).toBe(false);
    expect(
      isOpenApiMediaType('application/vnd.oai.openapi+json;version=3.0'),
    ).toBe(false);
  });
  it('normalizes a valid 3.1.2 document and bounded local refs deterministically', () => {
    const first = parseAndNormalizeOpenApi(
      declaration,
      'ard_url',
      declaration.url!,
      Buffer.from(JSON.stringify(valid())),
      'text/plain',
    );
    const reordered = parseAndNormalizeOpenApi(
      declaration,
      'ard_url',
      declaration.url!,
      Buffer.from(
        JSON.stringify({
          ...valid(),
          paths: Object.fromEntries(Object.entries(valid().paths).reverse()),
        }),
      ),
      'application/json',
    );
    expect(first).toMatchObject({
      status: 'valid',
      openapiVersion: '3.1.2',
      serialization: 'json',
      pathCount: 1,
      complete: true,
    });
    expect(first.operations[0]).toMatchObject({
      key: 'GET /items/{id}',
      parameters: [{ key: 'path:id', required: true }],
    });
    expect(reordered.operations).toEqual(first.operations);
  });
  it('supports safe YAML and rejects malformed YAML', () => {
    const yaml = `openapi: 3.1.2
info:
  title: Example
  version: 1.0.0
paths: {}
`;
    expect(
      parseAndNormalizeOpenApi(
        declaration,
        'ard_url',
        declaration.url!,
        Buffer.from(yaml),
        'application/yaml',
      ),
    ).toMatchObject({ status: 'valid', serialization: 'yaml' });
    expect(
      parseAndNormalizeOpenApi(
        declaration,
        'ard_url',
        declaration.url!,
        Buffer.from('openapi: [}'),
        'application/yaml',
      ),
    ).toMatchObject({ status: 'malformed' });
  });
  it('distinguishes unsupported and structurally invalid documents', () => {
    expect(
      parseAndNormalizeOpenApi(
        declaration,
        'ard_url',
        declaration.url!,
        Buffer.from(JSON.stringify({ ...valid(), openapi: '3.0.4' })),
      ),
    ).toMatchObject({ status: 'unsupported_version' });
    expect(
      parseAndNormalizeOpenApi(
        declaration,
        'ard_url',
        declaration.url!,
        Buffer.from(JSON.stringify({ openapi: '3.1.2', info: {} })),
      ),
    ).toMatchObject({ status: 'invalid' });
  });
  it('never resolves external refs and marks proof incomplete', () => {
    const document = valid({
      paths: {
        '/external': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: 'https://other.example/schema.json' },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const result = parseAndNormalizeOpenApi(
      declaration,
      'ard_url',
      declaration.url!,
      Buffer.from(JSON.stringify(document)),
    );
    expect(result.complete).toBe(false);
    expect(result.limitationCodes).toContain(
      'OPENAPI_EXTERNAL_REF_NOT_RESOLVED',
    );
  });
  it('records cross-origin declarations without contacting them', async () => {
    const cross = { ...declaration, url: 'https://other.example/openapi.json' };
    const fake = client(JSON.stringify(valid()));
    const result = await observeOpenApi(
      new URL('https://example.com'),
      summary(cross),
      fake,
    );
    expect(result.documents[0]).toMatchObject({
      status: 'declared_not_fetched',
      fetched: false,
    });
    expect(fake.get).not.toHaveBeenCalled();
  });
  it('observes inline data without a fake URL or network request', async () => {
    const inline = { ...declaration, url: undefined, data: valid() };
    const fake = client('');
    const result = await observeOpenApi(
      new URL('https://example.com'),
      summary(inline),
      fake,
    );
    expect(result.documents[0]).toMatchObject({
      status: 'valid',
      provenance: 'ard_inline',
      fetched: false,
    });
    expect(result.documents[0]!.artifactUrl).toBe(
      `inline:${inline.identifier}`,
    );
    expect(fake.get).not.toHaveBeenCalled();
  });
  it('uses the hardened client with explicit document bounds', async () => {
    const fake = client(JSON.stringify(valid()), 'text/plain');
    const result = await observeOpenApi(
      new URL('https://example.com'),
      summary(),
      fake,
    );
    expect(result.documents[0]).toMatchObject({
      status: 'valid',
      contentType: 'text/plain',
    });
    expect(fake.get).toHaveBeenCalledWith(
      new URL(declaration.url!),
      expect.objectContaining({
        maxBodyBytes: OPENAPI_LIMITS.maxDocumentBytes,
      }),
    );
  });
  it('bounds YAML alias expansion and cyclic local references', () => {
    const aliases = ['base: &base {type: string}'];
    for (let index = 0; index < OPENAPI_LIMITS.maxYamlAliases + 2; index += 1)
      aliases.push('alias' + index + ': *base');
    const bomb =
      'openapi: 3.1.2\ninfo: {title: Example, version: 1}\npaths: {}\ncomponents:\n  schemas:\n    ' +
      aliases.join('\n    ');
    expect(
      parseAndNormalizeOpenApi(
        declaration,
        'ard_url',
        declaration.url!,
        Buffer.from(bomb),
      ),
    ).toMatchObject({ status: 'malformed' });

    const cyclic = valid({
      paths: {
        '/cycle': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/A' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          A: { $ref: '#/components/schemas/B' },
          B: { $ref: '#/components/schemas/A' },
        },
      },
    });
    const result = parseAndNormalizeOpenApi(
      declaration,
      'ard_url',
      declaration.url!,
      Buffer.from(JSON.stringify(cyclic)),
    );
    expect(result.complete).toBe(false);
    expect(result.limitationCodes).toContain(
      'OPENAPI_LOCAL_REF_CYCLE_OR_DEPTH',
    );
  });

  it('enforces document and operation inventory bounds without claiming completeness', async () => {
    const declarations = Array.from(
      { length: OPENAPI_LIMITS.maxDocuments + 2 },
      (_, index) => ({
        ...declaration,
        identifier: 'urn:air:example.com:openapi:' + index,
        url: 'https://example.com/openapi-' + index + '.json',
      }),
    );
    const fake = client(JSON.stringify(valid()));
    const result = await observeOpenApi(
      new URL('https://example.com'),
      {
        ...summary(),
        entries: declarations.length,
        declarations,
        openApiUrls: declarations.map((item) => item.url),
      },
      fake,
    );
    expect(result.documents).toHaveLength(OPENAPI_LIMITS.maxDocuments);
    expect(result.totalOmitted).toBe(2);
    expect(result.complete).toBe(false);

    const paths = Object.fromEntries(
      Array.from({ length: OPENAPI_LIMITS.maxOperations + 1 }, (_, index) => [
        '/items/' + index,
        { get: { responses: { '200': { description: 'ok' } } } },
      ]),
    );
    const bounded = parseAndNormalizeOpenApi(
      declaration,
      'ard_url',
      declaration.url!,
      Buffer.from(JSON.stringify(valid({ paths }))),
    );
    expect(bounded.operations).toHaveLength(OPENAPI_LIMITS.maxOperations);
    expect(bounded.complete).toBe(false);
    expect(bounded.limitationCodes).toContain('OPENAPI_OPERATION_LIMIT');
  });

  it('does not let error pages spend the aggregate document budget', async () => {
    const declarations = Array.from(
      { length: OPENAPI_LIMITS.maxDocuments },
      (_, index) => ({
        ...declaration,
        identifier: 'urn:air:example.com:openapi:' + index,
        url: 'https://example.com/openapi-' + index + '.json',
      }),
    );
    // Two error pages, each reported at the full document limit, before a
    // valid third document.
    const errorPage = {
      ...response('', 'text/html'),
      httpStatus: 404,
      body: Buffer.alloc(OPENAPI_LIMITS.maxDocumentBytes, 'x'),
      truncated: true as const,
    };
    const get = vi.fn(async (url: URL) =>
      url.pathname === '/openapi-2.json'
        ? response(JSON.stringify(valid()))
        : {
            ...errorPage,
            httpStatus: url.pathname === '/openapi-0.json' ? 404 : 500,
          },
    );
    const result = await observeOpenApi(
      new URL('https://example.com'),
      {
        ...summary(),
        entries: declarations.length,
        declarations,
        openApiUrls: declarations.map((item) => item.url),
      },
      { get, post: vi.fn() },
    );
    expect(result.documents.map((item) => item.status)).toEqual([
      'not_found',
      'unreachable',
      'valid',
    ]);
    // The third request still gets the whole per-document allowance.
    expect(get).toHaveBeenLastCalledWith(
      new URL('https://example.com/openapi-2.json'),
      expect.objectContaining({
        maxBodyBytes: OPENAPI_LIMITS.maxDocumentBytes,
      }),
    );
  });

  it('records contacted blocked and oversized artifacts precisely', async () => {
    for (const [code, status] of [
      ['TARGET_BLOCKED', 'blocked'],
      ['RESPONSE_TOO_LARGE', 'too_large'],
    ] as const) {
      const fake: SafeOutboundClient = {
        get: vi.fn(async () => ({
          ok: false as const,
          code,
          message: code,
          durationMs: 1,
          redirects: [],
        })),
        post: vi.fn(),
      };
      const result = await observeOpenApi(
        new URL('https://example.com'),
        summary(),
        fake,
      );
      expect(result.documents[0]).toMatchObject({ status, fetched: true });
    }
  });
});
