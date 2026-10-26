import { describe, expect, it } from 'vitest';
import {
  passportSchema,
  type DiscoveryReport,
  type McpCandidateResult,
  extractPaymentChallenge,
} from '@interfacedelta/contracts';
import { canonicalJson, canonicalSha256, canonicalUrl } from './canonical-json';
import { normalizeDiscoveryReport } from './normalize';
import { extractWebMcpDeclarativeTools } from '../discovery/webmcp-html';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import machineSchema from './agent-passport.schema.json';

const inventory = <T>(items: T[], complete = true) => ({
  attempted: true,
  count: items.length,
  complete,
  pages: 1,
  cache: [],
  items,
  ...(!complete ? { truncatedReason: 'item_limit' as const } : {}),
});
function report(): DiscoveryReport {
  const candidate: McpCandidateResult = {
    endpoint: 'https://EXAMPLE.com:443/mcp#ignored',
    sources: ['user_supplied', 'ard_declared'],
    probePolicy: 'inspected',
    status: 'valid',
    targetOrigin: 'https://example.com',
    syntacticallyEligible: true,
    serverCardUrl: 'https://example.com/card.json',
    remoteTransport: 'streamable-http',
    protocol: {
      era: 'modern',
      version: '2026-07-28',
      supportedVersions: ['2026-07-28'],
      modernDiscoveryAttempted: true,
      legacyInitializeAttempted: false,
    },
    server: {
      selfReportedIdentity: { name: 'Acme MCP Server', version: '1' },
      instructionsPresent: true,
    },
    capabilities: { tools: true, resources: true, prompts: true },
    tools: inventory([
      {
        name: 'create_order',
        title: 'Create order',
        description: 'Creates one',
        inputSchemaPresent: true,
        inputSchemaSha256: 'input-a',
        outputSchemaPresent: false,
        annotationsPresent: false,
      },
    ]),
    resources: inventory([
      {
        uri: 'urn:example:orders',
        name: 'Orders',
        mimeType: 'application/json',
      },
    ]),
    prompts: inventory([
      { name: 'review_order', description: 'Review', argumentCount: 1 },
    ]),
  };
  return {
    inputUrl: 'https://example.com/path?q=1',
    origin: 'https://example.com',
    inspectedAt: '2026-01-01T00:00:00.000Z',
    ard: {
      status: 'valid',
      discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
      durationMs: 8,
      redirects: [],
      warnings: [],
      sha256: 'ard-hash',
      validation: undefined,
      summary: {
        specVersion: '1.0',
        entries: 2,
        entryTypes: [
          'application/a2a-agent-card+json',
          'application/mcp-server-card+json',
        ],
        hostPresent: true,
        mcpServerCardUrls: ['https://example.com/card.json'],
        declarations: [
          {
            identifier: 'urn:air:example.com:a2a:agent',
            displayName: 'Agent',
            type: 'application/a2a-agent-card+json',
            url: 'https://example.com/.well-known/agent-card.json',
          },
          {
            identifier: 'urn:air:example.com:mcp:card',
            displayName: 'Card',
            type: 'application/mcp-server-card+json',
            url: 'https://example.com/card.json',
          },
        ],
      },
    },
    a2a: {
      status: 'valid',
      discoveryUrl: 'https://example.com/.well-known/agent-card.json',
      durationMs: 9,
      redirects: [],
      warnings: [],
      summary: {
        name: 'Acme Research Agent',
        agentVersion: '1',
        description: 'Agent',
        skills: [
          {
            id: 'create_order',
            name: 'create_order',
            description: 'Create',
            tags: ['orders'],
            examples: [],
            inputModes: ['text/plain'],
            outputModes: ['application/json'],
          },
        ],
        interfaces: [
          {
            url: 'https://example.com/a2a',
            protocolBinding: 'JSONRPC',
            protocolVersion: '1.0',
          },
        ],
        interfaceCount: 1,
        securitySchemes: ['oauth'],
        capabilities: [],
        signaturePresent: false,
      },
    },
    mcp: {
      totalDeclared: 1,
      totalInspected: 1,
      totalOmitted: 0,
      serverCards: [
        {
          source: 'ard_declared',
          serverCardUrl: 'https://example.com/card.json',
          status: 'valid',
          fetched: true,
          validation: undefined,
          identity: { name: 'Acme Card', version: '1', description: 'Card' },
          remotes: [
            {
              transport: 'streamable-http',
              remoteEndpoint: 'https://example.com/mcp',
              concrete: true,
              headersDeclared: false,
              probePolicy: 'eligible',
            },
          ],
        },
      ],
      candidates: [candidate],
    },
  };
}

describe('canonical Agent Passport normalization', () => {
  it('is deterministic, validates at runtime and by machine schema, and ignores volatile timing', () => {
    const first = normalizeDiscoveryReport(report());
    const changed = {
      ...report(),
      inspectedAt: '2030-02-02T00:00:00.000Z',
      ard: { ...report().ard, durationMs: 999 },
      a2a: { ...report().a2a, durationMs: 777 },
    };
    const second = normalizeDiscoveryReport(changed);
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(passportSchema.safeParse(first).success).toBe(true);
    expect(ajv.validate(machineSchema, first), JSON.stringify(ajv.errors)).toBe(
      true,
    );
    expect(normalizeDiscoveryReport(report())).toEqual(first);
    expect(second.observation).not.toEqual(first.observation);
    expect(second.fingerprints.passport.value).toBe(
      first.fingerprints.passport.value,
    );
  });
  it('normalizes ordering and URL equivalence without removing meaningful paths or queries', () => {
    const original = report();
    const reordered: DiscoveryReport = {
      ...original,
      ard: {
        ...original.ard,
        summary: {
          ...original.ard.summary!,
          declarations: [...original.ard.summary!.declarations].reverse(),
        },
      },
      mcp: {
        ...original.mcp,
        candidates: [
          {
            ...original.mcp.candidates[0]!,
            sources: ['ard_declared', 'user_supplied'] as const,
          },
        ],
        serverCards: [...original.mcp.serverCards].reverse(),
      },
    };
    expect(
      normalizeDiscoveryReport(reordered).fingerprints.passport.value,
    ).toBe(normalizeDiscoveryReport(original).fingerprints.passport.value);
    expect(canonicalUrl('HTTPS://EXAMPLE.COM:443/mcp?q=1#x')).toBe(
      'https://example.com/mcp?q=1',
    );
    expect(canonicalUrl('https://example.com/mcp')).not.toBe(
      canonicalUrl('https://example.com/mcp/'),
    );
  });
  it('uses key-order-independent structural hashes but not schema semantic equivalence', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(
      canonicalSha256({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
      }),
    ).toBe(
      canonicalSha256({
        properties: { b: { type: 'number' }, a: { type: 'string' } },
        type: 'object',
      }),
    );
    expect(canonicalSha256({ type: ['string', 'null'] })).not.toBe(
      canonicalSha256({ anyOf: [{ type: 'string' }, { type: 'null' }] }),
    );
  });
  it('changes fingerprints for material capability changes and scopes IDs by endpoint', () => {
    const source = report();
    const candidate = source.mcp.candidates[0]!;
    const changed: DiscoveryReport = {
      ...source,
      mcp: {
        ...source.mcp,
        candidates: [
          {
            ...candidate,
            tools: {
              ...candidate.tools!,
              items: [{ ...candidate.tools!.items[0]!, name: 'replace_order' }],
            },
          },
        ],
      },
    };
    const first = normalizeDiscoveryReport(source);
    const second = normalizeDiscoveryReport(changed);
    expect(second.fingerprints.passport.value).not.toBe(
      first.fingerprints.passport.value,
    );
    expect(
      second.capabilities.find((item) => item.kind === 'mcp.tool')!.fingerprint
        .value,
    ).not.toBe(
      first.capabilities.find((item) => item.kind === 'mcp.tool')!.fingerprint
        .value,
    );
    const cross: DiscoveryReport = {
      ...source,
      mcp: {
        ...source.mcp,
        candidates: [
          candidate,
          {
            ...candidate,
            endpoint: 'https://other.example.com/mcp',
            serverCardUrl: undefined,
            sources: ['user_supplied'],
          },
        ],
      },
    };
    const toolIds = normalizeDiscoveryReport(cross)
      .capabilities.filter((item) => item.kind === 'mcp.tool')
      .map((item) => item.id);
    expect(new Set(toolIds).size).toBe(2);
  });
  it('preserves Server Card provenance and never conflates its URL with the live endpoint', () => {
    const passport = normalizeDiscoveryReport(report());
    const card = passport.artifacts.find(
      (item) => item.kind === 'mcp.server-card.experimental',
    )!;
    const endpoint = passport.endpoints.find(
      (item) => item.protocol === 'mcp',
    )!;
    expect(card.url).toBe('https://example.com/card.json');
    expect(endpoint.url).toBe('https://example.com/mcp');
    expect(endpoint.artifactRefs).toContain(card.id);
    expect(endpoint.declarationSources).toEqual([
      'ard_declared',
      'server_card_declared',
      'user_supplied',
    ]);
  });
  it('keeps the canonical MCP protocol status observed when every candidate failed', () => {
    // Presentation repairs this; changing the projection would turn
    // observed -> not_mcp into a false PROTOCOL_SURFACE_REMOVED.
    for (const status of ['unreachable', 'not_mcp'] as const) {
      const source = report();
      const candidate = source.mcp.candidates[0]!;
      const passport = normalizeDiscoveryReport({
        ...source,
        mcp: {
          ...source.mcp,
          candidates: [
            {
              endpoint: candidate.endpoint,
              sources: candidate.sources,
              probePolicy: 'inspected',
              targetOrigin: candidate.targetOrigin,
              syntacticallyEligible: true,
              network: candidate.network,
              status,
              error: { code: 'HTTP_ERROR', message: 'failed' },
            },
          ],
        },
      });
      expect(
        passport.protocols.find((item) => item.protocol === 'mcp')?.status,
      ).toBe('observed');
    }
  });
  it('keeps equal A2A skill and MCP tool names distinct without identity mismatch', () => {
    const passport = normalizeDiscoveryReport(report());
    expect(
      passport.capabilities
        .filter((item) => item.protocolKey === 'create_order')
        .map((item) => item.kind)
        .sort(),
    ).toEqual(['a2a.skill', 'mcp.tool']);
    expect(
      passport.consistency.findings.some(
        (item) =>
          item.code.includes('IDENTITY') || item.code.includes('A2A_MCP'),
      ),
    ).toBe(false);
    expect(passport.identityAssertions.map((item) => item.value)).toEqual(
      expect.arrayContaining(['Acme Research Agent', 'Acme MCP Server']),
    );
  });
  it.each([
    ['not_found', 'mismatch'],
    ['declared_not_fetched', 'indeterminate'],
  ] as const)(
    'classifies ARD Server Card %s conservatively',
    (cardStatus, expected) => {
      const source = report();
      const input: DiscoveryReport = {
        ...source,
        mcp: {
          ...source.mcp,
          serverCards: [
            {
              ...source.mcp.serverCards[0]!,
              status: cardStatus,
              fetched: false,
              remotes: [],
            },
          ],
          candidates: [],
        },
      };
      expect(
        normalizeDiscoveryReport(input).consistency.findings.find(
          (item) => item.code === 'ARD_DECLARED_MCP_SERVER_CARD',
        )?.status,
      ).toBe(expected);
    },
  );
  it.each([
    ['valid', 'match'],
    ['not_mcp', 'mismatch'],
    ['auth_required', 'indeterminate'],
    ['forbidden', 'indeterminate'],
    ['payment_required', 'indeterminate'],
  ] as const)(
    'classifies Server Card remote live state %s',
    (status, expected) => {
      const source = report();
      const input: DiscoveryReport = {
        ...source,
        mcp: {
          ...source.mcp,
          candidates: [
            {
              ...source.mcp.candidates[0]!,
              status,
              auth:
                status === 'auth_required'
                  ? { httpStatus: 401 }
                  : status === 'forbidden'
                    ? { httpStatus: 403 }
                    : status === 'payment_required'
                      ? { httpStatus: 402 }
                      : undefined,
            },
          ],
        },
      };
      expect(
        normalizeDiscoveryReport(input).consistency.findings.find(
          (item) => item.code === 'MCP_SERVER_CARD_REMOTE_OBSERVED',
        )?.status,
      ).toBe(expected);
    },
  );
  it('keeps a parsed 402 challenge out of the Passport and its fingerprint', () => {
    const source = report();
    const candidate = source.mcp.candidates[0]!;
    const base = {
      endpoint: candidate.endpoint,
      sources: candidate.sources,
      probePolicy: 'inspected' as const,
      targetOrigin: candidate.targetOrigin,
      syntacticallyEligible: true,
      network: candidate.network,
      status: 'payment_required' as const,
      auth: { httpStatus: 402 as const, insufficientScope: false },
    };
    const withChallenge = {
      ...base,
      paymentChallenge: {
        bodySha256: 'b'.repeat(64),
        bodyBytes: 64,
        contentType: 'application/json',
        observation: extractPaymentChallenge({
          resource: candidate.endpoint,
          httpStatus: 402,
          headers: { 'content-type': 'application/json' },
          bodyText: JSON.stringify({
            x402Version: 2,
            accepts: [{ scheme: 'exact', maxAmountRequired: '5000' }],
          }),
          retrievedAt: source.inspectedAt,
        })!,
      },
    };
    const passport = (item: typeof base) =>
      normalizeDiscoveryReport({
        ...source,
        mcp: { ...source.mcp, candidates: [item] },
      });
    expect(canonicalJson(passport(withChallenge))).toBe(
      canonicalJson(passport(base)),
    );
    expect(JSON.stringify(passport(withChallenge))).not.toMatch(
      /5000|maxAmountRequired|x402|b{64}/,
    );
  });
  it('records HTTP 402 as a payment_required endpoint with an observed access assertion', () => {
    const source = report();
    const candidate = source.mcp.candidates[0]!;
    const header = 'Payment realm="api"';
    const passport = normalizeDiscoveryReport({
      ...source,
      mcp: {
        ...source.mcp,
        candidates: [
          {
            endpoint: candidate.endpoint,
            sources: candidate.sources,
            probePolicy: 'inspected',
            targetOrigin: candidate.targetOrigin,
            syntacticallyEligible: true,
            network: candidate.network,
            status: 'payment_required',
            auth: {
              httpStatus: 402,
              wwwAuthenticate: header,
              insufficientScope: false,
            },
          },
        ],
      },
    });
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(passportSchema.safeParse(passport).success).toBe(true);
    expect(
      ajv.validate(machineSchema, passport),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const endpoint = passport.endpoints.find(
      (item) => item.protocol === 'mcp',
    )!;
    expect(endpoint.observationStatus).toBe('payment_required');
    expect(
      passport.accessAssertions.filter(
        (item) => item.kind === 'observed_http_access',
      ),
    ).toEqual([
      expect.objectContaining({
        endpointId: endpoint.id,
        name: 'payment_required',
        value: header,
      }),
    ]);
    expect(
      passport.capabilities.filter((item) => item.protocol === 'mcp'),
    ).toEqual([]);
  });
  const withWebMcp = (
    html: string,
    overrides: Partial<NonNullable<DiscoveryReport['webmcp']>> = {},
  ) => {
    const source = report();
    const observed = extractWebMcpDeclarativeTools(
      html,
      new URL(source.origin),
      `${source.origin}/`,
    );
    return {
      ...source,
      webmcp: { ...observed, ...overrides },
    } as DiscoveryReport;
  };
  const validates = (passport: unknown) => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(passportSchema.safeParse(passport).success).toBe(true);
    expect(
      ajv.validate(machineSchema, passport),
      JSON.stringify(ajv.errors),
    ).toBe(true);
  };
  it('records declarative WebMCP tools as a 0.5.0 artifact, inventory and capabilities', () => {
    const passport = normalizeDiscoveryReport(
      withWebMcp(
        '<form toolname="book" tooldescription="Book a table" toolautosubmit action="/reserve?csrf=abc" method="post"><input name="date" required toolparamdescription="Day"><input name="party"></form>',
      ),
    );
    validates(passport);
    expect(passport.schemaVersion).toBe('0.5.0');
    expect(passport.fingerprints.passport.projectionVersion).toBe(
      'passport-semantic-v4',
    );
    expect(
      passport.protocols.find((item) => item.protocol === 'webmcp'),
    ).toMatchObject({
      status: 'observed',
      artifactRefs: [expect.stringMatching(/^artifact:/)],
    });
    expect(
      passport.artifacts.find((item) => item.kind === 'webmcp.root-html'),
    ).toMatchObject({
      protocol: 'webmcp',
      status: 'observed',
      validationStatus: 'not_validated',
      bodySha256: undefined,
    });
    expect(
      passport.inventoryGroups.find((item) => item.kind === 'webmcp.tool'),
    ).toMatchObject({
      attempted: true,
      complete: true,
      itemCount: 1,
    });
    const tool = passport.capabilities.find(
      (item) => item.kind === 'webmcp.tool',
    )!;
    expect(tool).toMatchObject({
      protocol: 'webmcp',
      protocolKey: 'book',
      description: 'Book a table',
      fingerprint: { projectionVersion: 'capability-semantic-v4' },
    });
    expect(tool.metadata).toMatchObject({
      autoSubmit: true,
      method: 'post',
      actionRelationship: 'same_origin',
      action: '/reserve',
      controls: [
        expect.objectContaining({
          name: 'date',
          required: true,
          description: 'Day',
        }),
        expect.objectContaining({ name: 'party', required: false }),
      ],
    });
    expect(passport.fingerprints.passport.complete).toBe(true);
  });
  it('keeps sites without WebMCP stable regardless of the root page outcome', () => {
    const none = normalizeDiscoveryReport(withWebMcp('<main>No tools</main>'));
    const failed = normalizeDiscoveryReport(
      withWebMcp('', {
        status: 'not_observed',
        reason: 'unreachable',
        tools: [],
        toolCount: 0,
      }),
    );
    const absent = normalizeDiscoveryReport(report());
    validates(none);
    for (const passport of [none, failed, absent]) {
      expect(
        passport.protocols.find((item) => item.protocol === 'webmcp'),
      ).toMatchObject({
        status: 'not_detected',
        artifactRefs: [],
      });
      expect(
        passport.artifacts.some((item) => item.protocol === 'webmcp'),
      ).toBe(false);
    }
    expect(none.fingerprints.passport.value).toBe(
      failed.fingerprints.passport.value,
    );
    expect(none.fingerprints.passport.value).toBe(
      absent.fingerprints.passport.value,
    );
  });
  it('ignores per-request action tokens so fingerprints stay deterministic', () => {
    const first = normalizeDiscoveryReport(
      withWebMcp(
        '<form toolname="search" action="/find?token=1#a"><input name="q"></form>',
      ),
    );
    const second = normalizeDiscoveryReport(
      withWebMcp(
        '<form toolname="search" action="/find?token=2#b"><input name="q"></form>',
      ),
    );
    expect(second.fingerprints.passport.value).toBe(
      first.fingerprints.passport.value,
    );
  });
  it('keeps a submitted-page WebMCP scan out of the Passport and its fingerprints', () => {
    const submittedPage = extractWebMcpDeclarativeTools(
      '<form toolname="pay" tooldescription="Pay"><input name="card" required></form>',
      new URL('https://example.com/checkout'),
      'https://example.com/checkout',
      'submitted_page_html_declarative_forms',
    );
    expect(submittedPage.status).toBe('observed');
    for (const html of [
      '<p>no tools</p>',
      '<form toolname="book"><input name="date"></form>',
    ]) {
      const rootOnly = withWebMcp(html);
      const withPage = {
        ...rootOnly,
        webmcp: { ...rootOnly.webmcp!, submittedPage },
      } as typeof rootOnly;
      expect(canonicalJson(normalizeDiscoveryReport(withPage))).toBe(
        canonicalJson(normalizeDiscoveryReport(rootOnly)),
      );
    }
    const passport = normalizeDiscoveryReport({
      ...withWebMcp('<p>no tools</p>'),
      webmcp: { ...withWebMcp('<p>no tools</p>').webmcp!, submittedPage },
    } as ReturnType<typeof withWebMcp>);
    expect(
      passport.protocols.find((item) => item.protocol === 'webmcp')?.status,
    ).toBe('not_detected');
    expect(
      passport.capabilities.some((item) => item.protocolKey === 'pay'),
    ).toBe(false);
  });
  it('adds a page-target watched page as its own WebMCP artifact, inventory and tools', () => {
    const page = (path: string, html: string) =>
      extractWebMcpDeclarativeTools(
        html,
        new URL(`https://example.com${path}`),
        `https://example.com${path}`,
        'submitted_page_html_declarative_forms',
      );
    const report = (html: string, submittedPage: ReturnType<typeof page>) => {
      const base = withWebMcp(html);
      return {
        ...base,
        webmcp: { ...base.webmcp!, submittedPage },
      } as typeof base;
    };
    const checkout = page(
      '/checkout',
      '<form toolname="pay" tooldescription="Pay"><input name="card" required></form>',
    );
    const withRoot = report(
      '<form toolname="book"><input name="date"></form>',
      checkout,
    );
    const passport = normalizeDiscoveryReport(withRoot, {
      monitoredPage: '/checkout',
    });
    validates(passport);
    const pageArtifact = passport.artifacts.find(
      (item) => item.kind === 'webmcp.page-html',
    )!;
    expect(pageArtifact.url).toBe('https://example.com/checkout');
    expect(
      passport.protocols.find((item) => item.protocol === 'webmcp'),
    ).toMatchObject({
      status: 'observed',
      artifactRefs: expect.arrayContaining([pageArtifact.id]),
    });
    expect(
      passport.inventoryGroups.filter((item) => item.kind === 'webmcp.tool'),
    ).toHaveLength(2);
    const pay = passport.capabilities.find(
      (item) => item.protocolKey === 'pay',
    )!;
    expect(pay.sourceRef).toBe(pageArtifact.id);
    expect(pay.provenance).toContain('discovery:monitored-page-html');
    expect(
      passport.capabilities.find((item) => item.protocolKey === 'book')
        ?.sourceRef,
    ).not.toBe(pageArtifact.id);

    // Root-only content is byte-identical with or without the page option.
    const rootOnly = withWebMcp(
      '<form toolname="book"><input name="date"></form>',
    );
    expect(
      canonicalJson(
        normalizeDiscoveryReport(rootOnly, { monitoredPage: '/checkout' }),
      ),
    ).toBe(canonicalJson(normalizeDiscoveryReport(rootOnly)));
  });
  it('never lets one page-target take in a different page', () => {
    const other = extractWebMcpDeclarativeTools(
      '<form toolname="admin"><input name="x"></form>',
      new URL('https://example.com/other'),
      'https://example.com/other',
      'submitted_page_html_declarative_forms',
    );
    const base = withWebMcp('<p>no tools</p>');
    const passport = normalizeDiscoveryReport(
      {
        ...base,
        webmcp: { ...base.webmcp!, submittedPage: other },
      } as typeof base,
      { monitoredPage: '/checkout' },
    );
    expect(canonicalJson(passport)).toBe(
      canonicalJson(normalizeDiscoveryReport(base)),
    );
    expect(
      passport.capabilities.some((item) => item.protocolKey === 'admin'),
    ).toBe(false);
  });
  it('marks the WebMCP inventory incomplete for duplicate names or truncated tools', () => {
    const duplicated = normalizeDiscoveryReport(
      withWebMcp(
        '<form toolname="a"><input name="x"></form><form toolname="a"><input name="y"></form>',
      ),
    );
    const group = duplicated.inventoryGroups.find(
      (item) => item.kind === 'webmcp.tool',
    )!;
    expect(group).toMatchObject({
      complete: false,
      truncatedReason: 'duplicate_tool_name',
      itemCount: 1,
    });
    expect(
      duplicated.capabilities.filter((item) => item.kind === 'webmcp.tool'),
    ).toHaveLength(1);
    expect(duplicated.fingerprints.passport.complete).toBe(false);
    const truncated = normalizeDiscoveryReport(
      withWebMcp('<form toolname="a"><input name="x"></form>', {
        toolsTruncated: true,
      }),
    );
    expect(
      truncated.inventoryGroups.find((item) => item.kind === 'webmcp.tool'),
    ).toMatchObject({
      complete: false,
      truncatedReason: 'tool_limit',
    });
  });
  it('carries MCP Apps UI declarations in tool metadata without changing undeclared tool fingerprints', () => {
    const single = report();
    const first = single.mcp.candidates[0]!;
    const source: DiscoveryReport = {
      ...single,
      mcp: {
        ...single.mcp,
        candidates: [
          {
            ...first,
            tools: inventory([
              ...first.tools!.items,
              { ...first.tools!.items[0]!, name: 'second_tool' },
            ]),
          },
        ],
      },
    };
    const candidate = source.mcp.candidates[0]!;
    const withUndefinedKeys: DiscoveryReport = {
      ...source,
      mcp: {
        ...source.mcp,
        candidates: [
          {
            ...candidate,
            tools: {
              ...candidate.tools!,
              items: candidate.tools!.items.map((item) => ({
                ...item,
                uiResourceUri: undefined,
                uiResourceUriField: undefined,
                uiVisibility: undefined,
              })),
            },
          },
        ],
      },
    };
    const baseline = normalizeDiscoveryReport(source);
    expect(normalizeDiscoveryReport(withUndefinedKeys).fingerprints).toEqual(
      baseline.fingerprints,
    );
    const declared = normalizeDiscoveryReport({
      ...source,
      mcp: {
        ...source.mcp,
        candidates: [
          {
            ...candidate,
            tools: {
              ...candidate.tools!,
              items: candidate.tools!.items.map((item, index) =>
                index === 0
                  ? {
                      ...item,
                      uiResourceUri: 'ui://acme/view',
                      uiResourceUriField: 'ui.resourceUri' as const,
                      uiVisibility: ['model', 'app'],
                    }
                  : item,
              ),
            },
          },
        ],
      },
    });
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(passportSchema.safeParse(declared).success).toBe(true);
    expect(
      ajv.validate(machineSchema, declared),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const tools = (p: typeof declared) =>
      p.capabilities.filter((item) => item.kind === 'mcp.tool');
    expect(tools(declared)[0]!.metadata).toMatchObject({
      uiResourceUri: 'ui://acme/view',
      uiResourceUriField: 'ui.resourceUri',
      uiVisibility: ['model', 'app'],
    });
    expect(tools(declared)).toHaveLength(2);
    expect(
      tools(declared)
        .slice(1)
        .map((item) => item.fingerprint),
    ).toEqual(
      tools(baseline)
        .slice(1)
        .map((item) => item.fingerprint),
    );
    expect(tools(declared)[0]!.fingerprint).not.toEqual(
      tools(baseline)[0]!.fingerprint,
    );
  });
  it('preserves truncation and marks the Passport projection incomplete', () => {
    const source = report();
    const candidate = source.mcp.candidates[0]!;
    const input: DiscoveryReport = {
      ...source,
      mcp: {
        ...source.mcp,
        candidates: [
          {
            ...candidate,
            tools: {
              ...candidate.tools!,
              complete: false,
              truncatedReason: 'item_limit',
            },
          },
        ],
      },
    };
    const passport = normalizeDiscoveryReport(input);
    expect(
      passport.capabilities.find((item) => item.kind === 'mcp.tool')?.inventory,
    ).toEqual({ complete: false, truncatedReason: 'item_limit' });
    expect(passport.fingerprints.passport.complete).toBe(false);
    expect(
      passport.consistency.findings.find(
        (item) => item.code === 'MCP_TOOLS_ADVERTISEMENT_LIST',
      )?.status,
    ).toBe('indeterminate');
  });
  it('reports advertised list method-not-found as a narrow mismatch', () => {
    const source = report();
    const candidate = source.mcp.candidates[0]!;
    const input: DiscoveryReport = {
      ...source,
      mcp: {
        ...source.mcp,
        candidates: [
          {
            ...candidate,
            tools: {
              attempted: true,
              count: 0,
              complete: false,
              truncatedReason: 'malformed_result',
              pages: 0,
              cache: [],
              items: [],
              failureCode: 'JSON_RPC_ERROR',
              failureRpcCode: -32601,
            },
          },
        ],
      },
    };
    expect(
      normalizeDiscoveryReport(input).consistency.findings.find(
        (item) => item.code === 'MCP_TOOLS_ADVERTISEMENT_LIST',
      )?.status,
    ).toBe('mismatch');
  });
  it('records a cross-origin explicit endpoint without implying ownership', () => {
    const source = report();
    const candidate = {
      ...source.mcp.candidates[0]!,
      endpoint: 'https://mcp.vendor.example/mcp',
      serverCardUrl: undefined,
      sources: ['user_supplied'] as const,
    };
    const input: DiscoveryReport = {
      ...source,
      mcp: { ...source.mcp, serverCards: [], candidates: [candidate] },
    };
    expect(normalizeDiscoveryReport(input).endpoints[0]).toMatchObject({
      originRelationship: 'cross_origin',
      relationship: 'explicitly_inspected',
      declarationSources: ['user_supplied'],
    });
  });
  it('records invalid sources without mining capabilities', () => {
    const source = report();
    const input: DiscoveryReport = {
      ...source,
      a2a: { ...source.a2a, status: 'invalid', summary: undefined },
      mcp: {
        ...source.mcp,
        serverCards: [
          { ...source.mcp.serverCards[0]!, status: 'invalid', remotes: [] },
        ],
        candidates: [],
      },
    };
    const passport = normalizeDiscoveryReport(input);
    expect(
      passport.artifacts.find((item) => item.kind === 'a2a.agent-card')?.status,
    ).toBe('invalid');
    expect(passport.capabilities).toHaveLength(0);
  });
});
