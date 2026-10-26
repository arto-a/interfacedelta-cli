import { describe, expect, it } from 'vitest';
import type { AgentPassport, DiscoveryReport } from '@interfacedelta/contracts';
import { projectJsonSchema } from '@interfacedelta/schema-compatibility';
import { analyzeConsistency } from './consistency';

const baseReport = (): DiscoveryReport => ({
  inputUrl: 'https://example.com',
  origin: 'https://example.com',
  inspectedAt: '2026-08-28T00:00:00.000Z',
  ard: {
    status: 'valid',
    discoveryUrl: 'https://example.com/.well-known/ard.json',
    durationMs: 1,
    redirects: [],
    warnings: [],
    summary: {
      specVersion: 'v0.91',
      entries: 1,
      entryTypes: ['application/vnd.oai.openapi+json;version=3.1'],
      hostPresent: false,
      mcpServerCardUrls: [],
      openApiUrls: ['https://example.com/openapi.json'],
      declarations: [
        {
          identifier: 'openapi',
          displayName: 'API',
          type: 'application/vnd.oai.openapi+json;version=3.1',
          url: 'https://example.com/openapi.json',
        },
      ],
    },
  },
  a2a: {
    status: 'not_found',
    discoveryUrl: 'https://example.com/.well-known/agent-card.json',
    durationMs: 1,
    redirects: [],
    warnings: [],
  },
  mcp: {
    totalDeclared: 1,
    totalInspected: 1,
    totalOmitted: 0,
    serverCards: [],
    candidates: [],
  },
  openapi: {
    totalDeclared: 1,
    totalFetched: 1,
    totalOmitted: 0,
    complete: true,
    documents: [
      {
        declarationId: 'openapi',
        provenance: 'ard_url',
        declaredUrl: 'https://example.com/openapi.json',
        artifactUrl: 'https://example.com/openapi.json',
        status: 'valid',
        fetched: true,
        openapiVersion: '3.1.2',
        servers: [
          {
            url: 'https://example.com',
            concrete: true,
            resolvedOrigin: 'https://example.com',
          },
        ],
        securitySchemes: [],
        topLevelSecurityDeclared: false,
        pathCount: 1,
        operations: [],
        complete: true,
        limitationCodes: [],
      },
    ],
  },
});
const passport = {
  artifacts: [
    {
      id: 'artifact:openapi',
      kind: 'openapi.document',
      protocol: 'openapi',
      url: 'https://example.com/openapi.json',
      status: 'valid',
      validationStatus: 'valid',
      provenance: ['discovery:ard'],
    },
  ],
  endpoints: [],
  capabilities: [],
} as unknown as AgentPassport;
const mapped = (left: unknown, right: unknown, id = 'urn:test:capability') => {
  // Test fixture is intentionally mutable before it crosses the readonly production boundary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report = baseReport() as any;
  report.openapi!.documents[0]!.operations = [
    {
      key: 'POST /items',
      method: 'POST',
      path: '/items',
      tags: [],
      parameters: [],
      requestBody: {
        required: true,
        content: [
          {
            mediaType: 'application/json',
            schemaSha256: 'left',
            schemaCompatibility: projectJsonSchema(left),
            complete: true,
            limitationCodes: [],
          },
        ],
      },
      responses: [],
      securityDeclared: false,
      explicitCapability: { id, requestMediaType: 'application/json' },
      complete: true,
      limitationCodes: [],
    },
  ];
  report.mcp.candidates = [
    {
      endpoint: 'https://example.com/mcp',
      sources: ['user_supplied'],
      probePolicy: 'inspected',
      status: 'valid',
      durationMs: 1,
      redirects: [],
      tools: {
        count: 1,
        complete: true,
        pages: 1,
        items: [
          {
            name: 'create_item',
            inputSchemaPresent: true,
            inputSchemaSha256: 'right',
            inputSchemaCompatibility: projectJsonSchema(right),
            outputSchemaPresent: false,
            explicitCapabilityId: id,
            annotationsPresent: false,
          },
        ],
      },
    },
  ];
  return report;
};

describe('OpenAPI cross-interface consistency', () => {
  it('does not claim correspondence from the same name alone', () => {
    const report = mapped({ type: 'string' }, { type: 'string' });
    report.openapi!.documents[0]!.operations[0]!.explicitCapability = undefined;
    report.mcp.candidates[0]!.tools!.items[0]!.explicitCapabilityId = undefined;
    report.openapi!.documents[0]!.operations[0]!.operationId = 'create_item';
    const result = analyzeConsistency(report, passport);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'OPENAPI_MCP_EXPLICIT_MAPPING',
        status: 'not_applicable',
      }),
    );
  });

  it('proves equivalent supported schemas only after exact mapping', () => {
    const result = analyzeConsistency(
      mapped({ type: 'string' }, { type: 'string' }),
      passport,
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'OPENAPI_MCP_EXPLICIT_MAPPING',
        status: 'match',
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: 'OPENAPI_MCP_INPUT_SCHEMA_ALIGNMENT',
        status: 'match',
      }),
    );
  });

  it('reports proven conflict and unsupported semantics distinctly', () => {
    const mismatch = analyzeConsistency(
      mapped({ type: 'string' }, { type: 'number' }),
      passport,
    );
    expect(mismatch.findings).toContainEqual(
      expect.objectContaining({
        code: 'OPENAPI_MCP_INPUT_SCHEMA_ALIGNMENT',
        status: 'mismatch',
      }),
    );
    const indeterminate = analyzeConsistency(
      mapped(
        { oneOf: [{ type: 'string' }, { type: 'number' }] },
        { type: 'string' },
      ),
      passport,
    );
    expect(indeterminate.findings).toContainEqual(
      expect.objectContaining({
        code: 'OPENAPI_MCP_INPUT_SCHEMA_ALIGNMENT',
        status: 'indeterminate',
      }),
    );
  });
});
