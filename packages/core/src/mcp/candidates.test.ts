import { describe, expect, it, vi } from 'vitest';
import type { McpCandidateResult } from '@interfacedelta/contracts';
import type {
  RetrievalResult,
  SafeOutboundClient,
} from '../scanner/outbound-boundary';
import { observeMcp } from './candidates';

const result = (
  endpoint: URL,
  sources: McpCandidateResult['sources'],
): McpCandidateResult => ({
  endpoint: endpoint.href,
  sources,
  probePolicy: 'inspected',
  status: 'valid',
  targetOrigin: endpoint.origin,
  syntacticallyEligible: true,
});
const card = (remotes: unknown[]) => ({
  $schema:
    'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'example/server',
  version: '1.0.0',
  description: 'Fixture card.',
  remotes,
});
function outbound(
  documents: Record<string, { status?: number; body: unknown }>,
): SafeOutboundClient {
  return {
    get: vi.fn(async (url): Promise<RetrievalResult> => {
      const item = documents[url.href];
      if (!item) throw new Error(`Unexpected GET ${url.href}`);
      const body = Buffer.from(
        typeof item.body === 'string' ? item.body : JSON.stringify(item.body),
      );
      return {
        ok: true,
        httpStatus: item.status ?? 200,
        body,
        contentType: 'application/json',
        headers: { 'content-type': 'application/json' },
        finalUrl: url.href,
        durationMs: 1,
        redirects: [],
      };
    }),
    post: async () => {
      throw new Error('POST belongs to passive client fake');
    },
  };
}

describe('MCP Server Card candidate policy', () => {
  it('GETs an ARD Server Card, derives its remote, and never POSTs to the card URL', async () => {
    const network = outbound({
      'https://company.example.com/card.json': {
        body: card([
          { type: 'streamable-http', url: 'https://company.example.com/mcp' },
        ]),
      },
    });
    const inspect = vi.fn(
      async (endpoint: URL, sources: McpCandidateResult['sources']) =>
        result(endpoint, sources),
    );
    const report = await observeMcp(
      new URL('https://company.example.com'),
      undefined,
      ['https://company.example.com/card.json'],
      { inspect },
      network,
    );
    expect(network.get).toHaveBeenCalledWith(
      new URL('https://company.example.com/card.json'),
    );
    expect(inspect).toHaveBeenCalledWith(
      new URL('https://company.example.com/mcp'),
      ['ard_declared'],
    );
    expect(inspect).not.toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/card.json' }),
      expect.anything(),
    );
    expect(report.serverCards[0]).toMatchObject({
      status: 'valid',
      fetched: true,
    });
    expect(report.candidates[0]).toMatchObject({
      serverCardUrl: 'https://company.example.com/card.json',
      endpoint: 'https://company.example.com/mcp',
    });
  });
  it('validates inline Server Cards without a Server Card GET and preserves endpoint policy', async () => {
    const network = outbound({}),
      inspect = vi.fn(
        async (endpoint: URL, sources: McpCandidateResult['sources']) =>
          result(endpoint, sources),
      );
    const report = await observeMcp(
      new URL('https://company.example.com'),
      undefined,
      [],
      { inspect },
      network,
      [
        {
          identifier: 'urn:air:company.example.com:mcp:inline',
          data: card([
            { type: 'streamable-http', url: 'https://company.example.com/mcp' },
          ]),
        },
      ],
    );
    expect(network.get).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
    expect(report.serverCards[0]).toMatchObject({
      status: 'valid',
      inline: true,
      fetched: false,
      serverCardUrl: 'urn:air:company.example.com:mcp:inline',
    });
  });
  it('records a cross-origin card without fetching it', async () => {
    const network = outbound({});
    const inspect = vi.fn();
    const report = await observeMcp(
      new URL('https://company.example.com'),
      undefined,
      ['https://thirdparty.example.com/card.json'],
      { inspect: inspect as never },
      network,
    );
    expect(network.get).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(report.serverCards[0]).toMatchObject({
      status: 'declared_not_fetched',
      error: { code: 'CROSS_ORIGIN_CARD_NOT_FETCHED' },
    });
  });
  it('fetches a same-origin card but does not probe a cross-origin remote', async () => {
    const network = outbound({
      'https://company.example.com/card.json': {
        body: card([
          {
            type: 'streamable-http',
            url: 'https://mcp.vendor.example.com/mcp',
          },
        ]),
      },
    });
    const inspect = vi.fn();
    const report = await observeMcp(
      new URL('https://company.example.com'),
      undefined,
      ['https://company.example.com/card.json'],
      { inspect: inspect as never },
      network,
    );
    expect(network.get).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
    expect(report.candidates[0]).toMatchObject({
      status: 'declared_not_probed',
      error: { code: 'REMOTE_CROSS_ORIGIN_NOT_PROBED' },
    });
  });
  it('allows the same cross-origin remote when explicitly supplied and preserves both sources', async () => {
    const network = outbound({
      'https://company.example.com/card.json': {
        body: card([
          {
            type: 'streamable-http',
            url: 'https://mcp.vendor.example.com/mcp',
          },
        ]),
      },
    });
    const inspect = vi.fn(
      async (endpoint: URL, sources: McpCandidateResult['sources']) =>
        result(endpoint, sources),
    );
    const report = await observeMcp(
      new URL('https://company.example.com'),
      'https://mcp.vendor.example.com/mcp',
      ['https://company.example.com/card.json'],
      { inspect },
      network,
    );
    expect(inspect).toHaveBeenCalledOnce();
    expect(report.candidates[0]?.sources).toEqual([
      'ard_declared',
      'user_supplied',
    ]);
  });
  it.each([
    [
      { type: 'streamable-http', url: 'https://{tenant}.example.com/mcp' },
      'configuration_required',
    ],
    [
      {
        type: 'streamable-http',
        url: 'https://company.example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer {token}' }],
      },
      'configuration_required',
    ],
    [{ type: 'sse', url: 'https://company.example.com/sse' }, undefined],
  ])(
    'does not probe templated, configured, or unsupported remotes',
    async (remote, expectedStatus) => {
      const network = outbound({
        'https://company.example.com/card.json': { body: card([remote]) },
      });
      const inspect = vi.fn();
      const report = await observeMcp(
        new URL('https://company.example.com'),
        undefined,
        ['https://company.example.com/card.json'],
        { inspect: inspect as never },
        network,
      );
      expect(inspect).not.toHaveBeenCalled();
      if (expectedStatus)
        expect(report.candidates[0]?.status).toBe(expectedStatus);
      else expect(report.candidates).toHaveLength(0);
    },
  );
  it('keeps explicit endpoint behavior independent of Server Cards', async () => {
    const inspect = vi.fn(
      async (endpoint: URL, sources: McpCandidateResult['sources']) =>
        result(endpoint, sources),
    );
    const report = await observeMcp(
      new URL('https://company.example.com'),
      'https://mcp.vendor.example.com/mcp',
      [],
      { inspect },
      outbound({}),
    );
    expect(inspect).toHaveBeenCalledWith(
      new URL('https://mcp.vendor.example.com/mcp'),
      ['user_supplied'],
    );
    expect(report.serverCards).toEqual([]);
  });
  it('bounds aggregate eligible MCP endpoint inspection', async () => {
    const remotes = Array.from({ length: 6 }, (_, index) => ({
      type: 'streamable-http',
      url: `https://company.example.com/mcp-${index}`,
    }));
    const network = outbound({
        'https://company.example.com/card.json': { body: card(remotes) },
      }),
      inspect = vi.fn(
        async (endpoint: URL, sources: McpCandidateResult['sources']) =>
          result(endpoint, sources),
      );
    const report = await observeMcp(
      new URL('https://company.example.com'),
      undefined,
      ['https://company.example.com/card.json'],
      { inspect },
      network,
    );
    expect(inspect).toHaveBeenCalledTimes(4);
    expect(
      report.candidates.filter(
        (candidate) => candidate.error?.code === 'MCP_CANDIDATE_LIMIT',
      ),
    ).toHaveLength(2);
  });
});
