import { mcpAnnotationValues } from '../evidence/protocol-declarations';
import { createHash } from 'node:crypto';
import {
  PAYMENT_CHALLENGE_HEADER_MAX_CHARS,
  extractPaymentChallenge,
  type McpCandidateResult,
  type McpInventory,
  type McpPaymentChallenge,
  type McpPromptItem,
  type McpResourceItem,
  type McpResponseEvidence,
  type McpToolItem,
  type RetrievedResponse,
} from '@interfacedelta/contracts';
import { projectJsonSchema } from '@interfacedelta/schema-compatibility';
import { stripBidiControls } from '@interfacedelta/common/display-text';
import type {
  RetrievalResult,
  SafeOutboundClient,
} from '../scanner/outbound-boundary';
import { parseSseChunks } from './sse';

export const MCP_LIMITS = {
  responseBytes: 512 * 1024,
  totalBytes: 2 * 1024 * 1024,
  maxPages: 5,
  maxItems: 1_000,
  maxRequests: 18,
} as const;
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const LEGACY_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]);
const CLIENT_INFO = { name: 'InterfaceDelta', version: '0.1' } as const;
const text = (value: unknown, max = 2_000): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : undefined;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
// MCP Apps, specification/2026-01-26/apps.mdx at modelcontextprotocol/ext-apps@6d9bdc7.
const mcpAppsUi = (meta: Record<string, unknown> | undefined) => {
  const ui = object(meta?.ui);
  const nested = text(ui?.resourceUri, 2_000) || undefined;
  // A present nested key, even empty, is authoritative; the flat key is deprecated.
  const flat =
    ui && 'resourceUri' in ui
      ? undefined
      : text(meta?.['ui/resourceUri'], 2_000) || undefined;
  const visibility = Array.isArray(ui?.visibility)
    ? ui.visibility
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 8)
        .map((item) => item.slice(0, 40))
    : undefined;
  return {
    uiResourceUri: nested ?? flat,
    uiResourceUriField: nested
      ? ('ui.resourceUri' as const)
      : flat
        ? ('ui/resourceUri' as const)
        : undefined,
    uiVisibility: visibility,
  };
};
const canonicalize = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalize)
    : object(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b, 'en'))
            .map(([key, item]) => [key, canonicalize(item)]),
        )
      : value;
const artifactHash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');

type RpcResult =
  | {
      ok: true;
      result: Record<string, unknown>;
      evidence: McpResponseEvidence;
      headers: Readonly<Record<string, string | undefined>>;
    }
  | {
      ok: false;
      kind: 'auth' | 'network' | 'not_mcp' | 'protocol';
      code: string;
      message: string;
      httpStatus?: number;
      wwwAuthenticate?: string;
      rpcCode?: number;
      evidence?: McpResponseEvidence;
      paymentChallenge?: McpPaymentChallenge;
    };

/**
 * A retrieved document as PR #101 extends it: the outbound boundary may mark
 * a non-2xx body it cut at the response bound. Absent means complete, which
 * every retrieval on this branch is.
 */
type RetrievedDocumentMaybeTruncated = Extract<
  RetrievalResult,
  { ok: true }
> & {
  readonly truncated?: boolean;
};

/**
 * The extractor's view of a complete, already-retrieved 402: its content
 * type, its two challenge headers and its body text. A body that is not UTF-8
 * is passed as no body.
 */
export function paymentChallengeResponse(
  retrieval: Extract<RetrievalResult, { ok: true }>,
  contentType: string | undefined,
  wwwAuthenticate: string | undefined,
  retrievedAt = new Date().toISOString(),
): RetrievedResponse {
  let bodyText: string | null = null;
  if (retrieval.body.length)
    try {
      bodyText = new TextDecoder('utf-8', { fatal: true }).decode(
        retrieval.body,
      );
    } catch {
      bodyText = null;
    }
  return {
    resource: retrieval.finalUrl,
    httpStatus: 402,
    headers: {
      'content-type': contentType,
      'www-authenticate': wwwAuthenticate,
      'payment-required': retrieval.headers['payment-required'],
    },
    bodyText,
    retrievedAt,
  };
}

export interface PassiveMcpClient {
  inspect(
    endpoint: URL,
    sources: McpCandidateResult['sources'],
  ): Promise<McpCandidateResult>;
}

export class HttpPassiveMcpClient implements PassiveMcpClient {
  private requestId = 0;
  private totalBytes = 0;
  private requestCount = 0;
  private evidence: McpResponseEvidence[] = [];
  /** `clientInfo` names the caller; the CLI identifies itself and its version. */
  constructor(
    private readonly outbound: SafeOutboundClient,
    private readonly clientInfo: {
      name: string;
      version: string;
    } = CLIENT_INFO,
  ) {}

  async inspect(
    endpoint: URL,
    sources: McpCandidateResult['sources'],
  ): Promise<McpCandidateResult> {
    const started = performance.now();
    this.requestId = 0;
    this.totalBytes = 0;
    this.requestCount = 0;
    this.evidence = [];
    const discover = await this.rpc(
      endpoint,
      'server/discover',
      {},
      MODERN_VERSION,
    );
    if (!discover.ok) {
      if (discover.kind === 'auth')
        return this.authResult(endpoint, sources, discover, started);
      // Some pre-2026-07-28 servers reject the optional discover call with a
      // plain 400; retry once through the legacy handshake. 401/402/403 were
      // handled above; 404, 5xx and policy failures stay terminal.
      const legacyFallbackReason =
        discover.kind === 'protocol' && discover.rpcCode === -32601
          ? 'server/discover returned JSON-RPC method not found'
          : discover.code === 'HTTP_ERROR' && discover.httpStatus === 400
            ? 'server/discover returned HTTP 400 before initialization'
            : undefined;
      if (!legacyFallbackReason)
        return this.failureResult(endpoint, sources, discover, started);
      return this.inspectLegacy(
        endpoint,
        sources,
        legacyFallbackReason,
        started,
      );
    }
    const supportedRaw = Array.isArray(discover.result.supportedVersions)
      ? discover.result.supportedVersions.filter(
          (item): item is string => typeof item === 'string',
        )
      : undefined;
    const capabilities = object(discover.result.capabilities);
    if (
      !supportedRaw ||
      !capabilities ||
      this.invalidKnownCapabilities(capabilities) ||
      (discover.result.resultType !== undefined &&
        discover.result.resultType !== 'complete')
    )
      return this.protocolFailure(
        endpoint,
        sources,
        'MALFORMED_DISCOVER_RESULT',
        'server/discover returned an invalid or interactive result.',
        started,
      );
    const supported = supportedRaw
      .slice(0, 100)
      .map((version) => version.slice(0, 40));
    if (!supportedRaw.includes(MODERN_VERSION))
      return this.inspectLegacy(
        endpoint,
        sources,
        'server/discover did not advertise 2026-07-28',
        started,
        supported,
      );
    return this.inventory(
      endpoint,
      sources,
      {
        era: 'modern',
        version: MODERN_VERSION,
        supportedVersions: supported,
        modernDiscoveryAttempted: true,
        legacyInitializeAttempted: false,
      },
      discover.result,
      undefined,
      started,
    );
  }

  private async inspectLegacy(
    endpoint: URL,
    sources: McpCandidateResult['sources'],
    fallbackReason: string,
    started: number,
    supportedVersions: string[] = [],
  ): Promise<McpCandidateResult> {
    const initialized = await this.rpc(
      endpoint,
      'initialize',
      {
        protocolVersion: LEGACY_VERSION,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
      undefined,
    );
    if (!initialized.ok)
      return initialized.kind === 'auth'
        ? this.authResult(endpoint, sources, initialized, started)
        : this.failureResult(endpoint, sources, initialized, started);
    const version = text(initialized.result.protocolVersion, 40);
    const capabilities = object(initialized.result.capabilities);
    if (
      !version ||
      !capabilities ||
      this.invalidKnownCapabilities(capabilities) ||
      !object(initialized.result.serverInfo)
    )
      return this.protocolFailure(
        endpoint,
        sources,
        'MALFORMED_INITIALIZE_RESULT',
        'Legacy initialize returned an invalid result.',
        started,
      );
    if (!LEGACY_VERSIONS.has(version))
      return this.protocolFailure(
        endpoint,
        sources,
        'UNSUPPORTED_VERSION',
        'Legacy initialize negotiated an unsupported protocol version.',
        started,
        'unsupported_version',
      );
    const session = initialized.headers['mcp-session-id'];
    if (session && !/^[\x21-\x7e]{1,256}$/.test(session))
      return this.protocolFailure(
        endpoint,
        sources,
        'INVALID_SESSION_ID',
        'Server returned an invalid MCP session identifier.',
        started,
      );
    const notification = await this.notify(
      endpoint,
      'notifications/initialized',
      {},
      version,
      session,
    );
    if (notification)
      return this.failureResult(endpoint, sources, notification, started);
    return this.inventory(
      endpoint,
      sources,
      {
        era: 'legacy',
        version,
        supportedVersions,
        modernDiscoveryAttempted: true,
        legacyInitializeAttempted: true,
        fallbackReason,
      },
      initialized.result,
      session,
      started,
    );
  }

  private async inventory(
    endpoint: URL,
    sources: McpCandidateResult['sources'],
    protocol: NonNullable<McpCandidateResult['protocol']>,
    handshake: Record<string, unknown>,
    session: string | undefined,
    started: number,
  ): Promise<McpCandidateResult> {
    const capabilities = object(handshake.capabilities)!;
    const [tools, resources, prompts] = await Promise.all([
      capabilities.tools !== undefined
        ? this.list(
            endpoint,
            'tools/list',
            'tools',
            protocol.version,
            session,
            this.mapTool,
          )
        : this.notAdvertised<McpToolItem>(),
      capabilities.resources !== undefined
        ? this.list(
            endpoint,
            'resources/list',
            'resources',
            protocol.version,
            session,
            this.mapResource,
          )
        : this.notAdvertised<McpResourceItem>(),
      capabilities.prompts !== undefined
        ? this.list(
            endpoint,
            'prompts/list',
            'prompts',
            protocol.version,
            session,
            this.mapPrompt,
          )
        : this.notAdvertised<McpPromptItem>(),
    ]);
    const serverInfo =
      protocol.era === 'modern'
        ? object(
            object(handshake._meta)?.['io.modelcontextprotocol/serverInfo'],
          )
        : object(handshake.serverInfo);
    const instructions = text(handshake.instructions, 500);
    const truncated =
      !tools.complete || !resources.complete || !prompts.complete;
    return {
      endpoint: endpoint.href,
      sources,
      probePolicy: 'inspected',
      status: truncated ? 'truncated' : 'valid',
      targetOrigin: endpoint.origin,
      syntacticallyEligible: true,
      protocol,
      server: {
        selfReportedIdentity:
          serverInfo &&
          typeof serverInfo.name === 'string' &&
          typeof serverInfo.version === 'string'
            ? {
                name: text(serverInfo.name, 200)!,
                version: text(serverInfo.version, 100)!,
                description: text(serverInfo.description, 500),
              }
            : undefined,
        instructionsPresent: typeof handshake.instructions === 'string',
        instructionsPreview: instructions,
      },
      capabilities: {
        tools: capabilities.tools !== undefined,
        resources: capabilities.resources !== undefined,
        prompts: capabilities.prompts !== undefined,
      },
      tools,
      resources,
      prompts,
      network: this.network(started),
    };
  }

  private async list<T>(
    endpoint: URL,
    method: 'tools/list' | 'resources/list' | 'prompts/list',
    field: 'tools' | 'resources' | 'prompts',
    version: string,
    session: string | undefined,
    map: (value: unknown) => T | undefined,
  ): Promise<McpInventory<T>> {
    const items: T[] = [];
    const seen = new Set<string>();
    const cache: { ttlMs?: number; scope?: 'public' | 'private' }[] = [];
    let cursor: string | undefined;
    for (let page = 1; page <= MCP_LIMITS.maxPages; page++) {
      const response = await this.rpc(
        endpoint,
        method,
        cursor ? { cursor } : {},
        version,
        session,
      );
      if (!response.ok)
        return {
          attempted: true,
          count: items.length,
          complete: false,
          truncatedReason:
            response.code === 'TOTAL_BYTE_LIMIT'
              ? 'byte_limit'
              : 'malformed_result',
          pages: page - 1,
          cache,
          items,
          failureCode: response.code,
          failureRpcCode: response.rpcCode,
        };
      const values = response.result[field];
      if (
        (response.result.resultType !== undefined &&
          response.result.resultType !== 'complete') ||
        !Array.isArray(values)
      )
        return {
          attempted: true,
          count: items.length,
          complete: false,
          truncatedReason: 'malformed_result',
          pages: page,
          cache,
          items,
        };
      if (
        typeof response.result.ttlMs === 'number' ||
        response.result.cacheScope === 'public' ||
        response.result.cacheScope === 'private'
      )
        cache.push({
          ttlMs:
            typeof response.result.ttlMs === 'number'
              ? response.result.ttlMs
              : undefined,
          scope:
            response.result.cacheScope === 'public' ||
            response.result.cacheScope === 'private'
              ? response.result.cacheScope
              : undefined,
        });
      for (const value of values) {
        const mapped = map(value);
        if (!mapped)
          return {
            attempted: true,
            count: items.length,
            complete: false,
            truncatedReason: 'malformed_result',
            pages: page,
            cache,
            items,
          };
        items.push(mapped);
        if (items.length === MCP_LIMITS.maxItems)
          return {
            attempted: true,
            count: items.length,
            complete: false,
            truncatedReason: 'item_limit',
            pages: page,
            cache,
            items,
          };
      }
      const next = response.result.nextCursor;
      if (next === undefined)
        return {
          attempted: true,
          count: items.length,
          complete: true,
          pages: page,
          cache,
          items,
        };
      if (typeof next !== 'string' || next.length === 0 || next.length > 4096)
        return {
          attempted: true,
          count: items.length,
          complete: false,
          truncatedReason: 'malformed_result',
          pages: page,
          cache,
          items,
        };
      if (seen.has(next))
        return {
          attempted: true,
          count: items.length,
          complete: false,
          truncatedReason: 'repeated_cursor',
          pages: page,
          cache,
          items,
        };
      seen.add(next);
      cursor = next;
      if (page === MCP_LIMITS.maxPages)
        return {
          attempted: true,
          count: items.length,
          complete: false,
          truncatedReason: 'page_limit',
          pages: page,
          cache,
          items,
        };
    }
    throw new Error('Unreachable pagination state');
  }

  private readonly mapTool = (value: unknown): McpToolItem | undefined => {
    const item = object(value);
    if (!item || typeof item.name !== 'string' || !object(item.inputSchema))
      return undefined;
    return {
      name: item.name.slice(0, 300),
      title: text(item.title, 300),
      description: text(item.description),
      inputSchemaPresent: true,
      inputSchemaSha256: artifactHash(item.inputSchema),
      inputSchemaCompatibility: projectJsonSchema(item.inputSchema),
      outputSchemaPresent: object(item.outputSchema) !== undefined,
      outputSchemaSha256: object(item.outputSchema)
        ? artifactHash(item.outputSchema)
        : undefined,
      outputSchemaCompatibility: object(item.outputSchema)
        ? projectJsonSchema(item.outputSchema)
        : undefined,
      explicitCapabilityId:
        typeof object(item._meta)?.['com.interfacedelta/capabilityId'] ===
        'string'
          ? String(
              object(item._meta)!['com.interfacedelta/capabilityId'],
            ).slice(0, 512)
          : undefined,
      annotationsPresent: object(item.annotations) !== undefined,
      publisherDeclarations: mcpAnnotationValues(item.annotations),
      ...mcpAppsUi(object(item._meta)),
    };
  };
  private readonly mapResource = (
    value: unknown,
  ): McpResourceItem | undefined => {
    const item = object(value);
    if (!item || typeof item.uri !== 'string' || typeof item.name !== 'string')
      return undefined;
    return {
      uri: item.uri.slice(0, 2000),
      name: item.name.slice(0, 300),
      title: text(item.title, 300),
      description: text(item.description),
      mimeType: text(item.mimeType, 200),
      size:
        typeof item.size === 'number' &&
        Number.isSafeInteger(item.size) &&
        item.size >= 0
          ? item.size
          : undefined,
    };
  };
  private readonly mapPrompt = (value: unknown): McpPromptItem | undefined => {
    const item = object(value);
    if (
      !item ||
      typeof item.name !== 'string' ||
      (item.arguments !== undefined && !Array.isArray(item.arguments))
    )
      return undefined;
    return {
      name: item.name.slice(0, 300),
      title: text(item.title, 300),
      description: text(item.description),
      argumentCount: Array.isArray(item.arguments) ? item.arguments.length : 0,
    };
  };
  private notAdvertised<T>(): McpInventory<T> {
    return {
      attempted: false,
      reason: 'not_advertised',
      count: 0,
      complete: true,
      pages: 0,
      cache: [],
      items: [],
    };
  }

  private async rpc(
    endpoint: URL,
    method: string,
    params: Record<string, unknown>,
    version?: string,
    session?: string,
  ): Promise<RpcResult> {
    const id = `passport-${++this.requestId}`;
    const modern = version === MODERN_VERSION;
    const rpcParams = modern
      ? {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
            'io.modelcontextprotocol/clientInfo': this.clientInfo,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        }
      : params;
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id, method, params: rpcParams }),
    );
    const response = await this.send(
      endpoint,
      method,
      body,
      version,
      session,
      id,
    );
    if (!response.ok) return response;
    const parsed = this.parseResponse(
      response.retrieval.body,
      response.retrieval.contentType,
      id,
    );
    if (!parsed.ok)
      return this.withEvidenceFailure(
        parsed.kind,
        parsed.code,
        parsed.message,
        response.evidence,
      );
    const message = parsed.message;
    if (message.jsonrpc !== '2.0' || message.id !== id)
      return this.withEvidenceFailure(
        'protocol',
        'WRONG_RESPONSE_ID',
        'JSON-RPC response version or ID did not match the request.',
        response.evidence,
      );
    if (object(message.error)) {
      const error = object(message.error)!;
      return {
        ok: false,
        kind: 'protocol',
        code: 'JSON_RPC_ERROR',
        message: text(error.message, 500) ?? 'JSON-RPC error.',
        rpcCode: typeof error.code === 'number' ? error.code : undefined,
        evidence: response.evidence,
      };
    }
    const result = object(message.result);
    if (!result)
      return this.withEvidenceFailure(
        'protocol',
        'MALFORMED_RESULT',
        'JSON-RPC result was missing or invalid.',
        response.evidence,
      );
    return {
      ok: true,
      result,
      evidence: response.evidence,
      headers: response.retrieval.headers,
    };
  }

  private async notify(
    endpoint: URL,
    method: 'notifications/initialized',
    params: Record<string, unknown>,
    version: string,
    session?: string,
  ): Promise<Extract<RpcResult, { ok: false }> | undefined> {
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', method, params }),
    );
    const sent = await this.send(endpoint, method, body, version, session);
    if (!sent.ok) return sent;
    if (sent.retrieval.httpStatus < 200 || sent.retrieval.httpStatus >= 300)
      return this.withEvidenceFailure(
        'protocol',
        'NOTIFICATION_REJECTED',
        'Server rejected initialized notification.',
        sent.evidence,
      );
    return undefined;
  }

  private async send(
    endpoint: URL,
    method: string,
    body: Buffer,
    version?: string,
    session?: string,
    expectedId?: string,
  ): Promise<
    | {
        ok: true;
        retrieval: Extract<RetrievalResult, { ok: true }>;
        evidence: McpResponseEvidence;
      }
    | Extract<RpcResult, { ok: false }>
  > {
    if (++this.requestCount > MCP_LIMITS.maxRequests)
      return {
        ok: false,
        kind: 'protocol',
        code: 'REQUEST_LIMIT',
        message: 'MCP request limit exceeded.',
      };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': method,
    };
    if (version) headers['mcp-protocol-version'] = version;
    if (session) headers['mcp-session-id'] = session;
    const retrieval = await this.outbound.post(endpoint, {
      body,
      headers,
      maxBodyBytes: MCP_LIMITS.responseBytes,
      stopAfterBody: expectedId
        ? (bytes, contentType) =>
            this.hasTerminalSseEvent(bytes, contentType, expectedId)
        : undefined,
    });
    if (!retrieval.ok)
      return {
        ok: false,
        kind: retrieval.code === 'TARGET_BLOCKED' ? 'network' : 'network',
        code: retrieval.code,
        message: retrieval.message,
        httpStatus: retrieval.httpStatus,
      };
    const evidence: McpResponseEvidence = {
      method,
      httpStatus: retrieval.httpStatus,
      bytes: retrieval.body.length,
      durationMs: retrieval.durationMs,
      sha256: createHash('sha256').update(retrieval.body).digest('hex'),
      finalUrl: retrieval.finalUrl,
      redirects: retrieval.redirects,
      ...(retrieval.truncated ? { truncated: true as const } : {}),
    };
    this.evidence.push(evidence);
    this.totalBytes += retrieval.body.length;
    if (this.totalBytes > MCP_LIMITS.totalBytes)
      return this.withEvidenceFailure(
        'protocol',
        'TOTAL_BYTE_LIMIT',
        'MCP endpoint exceeded the total response byte limit.',
        evidence,
      );
    if (retrieval.httpStatus === 401 || retrieval.httpStatus === 403)
      return {
        ok: false,
        kind: 'auth',
        code: 'AUTH_REQUIRED',
        message: 'MCP endpoint requires authentication.',
        httpStatus: retrieval.httpStatus,
        wwwAuthenticate: this.safeAuth(retrieval.headers['www-authenticate']),
        evidence,
      };
    // Payment is an HTTP access barrier like 401/403; nothing is offered or paid.
    if (retrieval.httpStatus === 402) {
      const wwwAuthenticate = this.safeAuth(
        retrieval.headers['www-authenticate'],
      );
      return {
        ok: false,
        kind: 'auth',
        code: 'PAYMENT_REQUIRED',
        message: 'MCP endpoint returned HTTP 402 Payment Required.',
        httpStatus: 402,
        wwwAuthenticate,
        evidence,
        // The Passport keeps the 512-character value above. The challenge
        // record, which never reaches the Passport, keeps up to the
        // extractor's bound; one character more lets it see a longer header.
        paymentChallenge: this.paymentChallenge(
          retrieval,
          evidence,
          this.safeAuth(
            retrieval.headers['www-authenticate'],
            PAYMENT_CHALLENGE_HEADER_MAX_CHARS + 1,
          ),
        ),
      };
    }
    if (retrieval.httpStatus < 200 || retrieval.httpStatus >= 300)
      return {
        ok: false,
        kind: retrieval.httpStatus === 404 ? 'not_mcp' : 'network',
        code: 'HTTP_ERROR',
        message: `MCP endpoint returned HTTP ${retrieval.httpStatus}.`,
        httpStatus: retrieval.httpStatus,
        evidence,
      };
    return { ok: true, retrieval, evidence };
  }

  private hasTerminalSseEvent(
    body: Buffer,
    contentType: string | undefined,
    id: string,
  ): boolean {
    if (!contentType?.toLowerCase().startsWith('text/event-stream'))
      return false;
    const raw = body.toString('utf8');
    if (!/(?:\r\n\r\n|\n\n|\r\r)$/.test(raw)) return false;
    const parsed = parseSseChunks([body]);
    if (!parsed.ok) return true;
    return parsed.events.some((data) => {
      try {
        const message = object(JSON.parse(data));
        return Boolean(
          message &&
          Object.prototype.hasOwnProperty.call(message, 'id') &&
          (message.id === id ||
            typeof message.method === 'string' ||
            message.id !== id),
        );
      } catch {
        return true;
      }
    });
  }

  private parseResponse(
    body: Buffer,
    contentType: string | undefined,
    id: string,
  ):
    | { ok: true; message: Record<string, unknown> }
    | {
        ok: false;
        kind: 'not_mcp' | 'protocol';
        code: string;
        message: string;
      } {
    const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'text/event-stream') {
      if (mediaType !== 'application/json')
        return {
          ok: false,
          kind: 'protocol',
          code: 'UNSUPPORTED_CONTENT_TYPE',
          message:
            'MCP response Content-Type was neither application/json nor text/event-stream.',
        };
      try {
        const message = object(JSON.parse(body.toString('utf8')));
        return message
          ? { ok: true, message }
          : {
              ok: false,
              kind: 'not_mcp',
              code: 'MALFORMED_JSON_RPC',
              message: 'Response was not a JSON-RPC object.',
            };
      } catch {
        return {
          ok: false,
          kind: 'not_mcp',
          code: 'MALFORMED_JSON_RPC',
          message: 'Response was not valid JSON.',
        };
      }
    }
    const stream = parseSseChunks([body]);
    if (!stream.ok)
      return {
        ok: false,
        kind: 'protocol',
        code: stream.code,
        message: stream.message,
      };
    for (const data of stream.events) {
      let message: Record<string, unknown> | undefined;
      try {
        message = object(JSON.parse(data));
      } catch {
        return {
          ok: false,
          kind: 'not_mcp',
          code: 'MALFORMED_SSE_JSON_RPC',
          message: 'SSE data event was not valid JSON-RPC JSON.',
        };
      }
      if (!message || message.jsonrpc !== '2.0')
        return {
          ok: false,
          kind: 'not_mcp',
          code: 'MALFORMED_SSE_JSON_RPC',
          message: 'SSE data event was not a JSON-RPC object.',
        };
      const hasMethod = typeof message.method === 'string';
      const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
      if (hasMethod && hasId)
        return {
          ok: false,
          kind: 'protocol',
          code: 'UNSUPPORTED_INTERACTIVE_REQUEST',
          message:
            'Server sent an interactive JSON-RPC request; passive inspection does not answer it.',
        };
      if (hasMethod && !hasId) continue;
      if (!hasId)
        return {
          ok: false,
          kind: 'protocol',
          code: 'MALFORMED_SSE_JSON_RPC',
          message:
            'SSE JSON-RPC message was neither a notification nor response.',
        };
      if (message.id !== id)
        return {
          ok: false,
          kind: 'protocol',
          code: 'WRONG_RESPONSE_ID',
          message: 'JSON-RPC response ID did not match the request.',
        };
      return { ok: true, message };
    }
    return {
      ok: false,
      kind: 'protocol',
      code: 'SSE_RESPONSE_MISSING',
      message: 'SSE response ended without the matching JSON-RPC response.',
    };
  }
  private safeAuth(value?: string, max = 512): string | undefined {
    return value === undefined
      ? undefined
      : [...stripBidiControls(value)]
          .filter((character) => {
            const code = character.codePointAt(0)!;
            return code > 31 && (code < 127 || code > 159);
          })
          .join('')
          .slice(0, max);
  }
  private invalidKnownCapabilities(
    capabilities: Record<string, unknown>,
  ): boolean {
    return ['tools', 'resources', 'prompts'].some(
      (name) => capabilities[name] !== undefined && !object(capabilities[name]),
    );
  }
  private withEvidenceFailure(
    kind: 'auth' | 'network' | 'not_mcp' | 'protocol',
    code: string,
    message: string,
    evidence: McpResponseEvidence,
  ): Extract<RpcResult, { ok: false }> {
    return { ok: false, kind, code, message, evidence };
  }
  private network(started: number) {
    return {
      totalDurationMs: Math.round(performance.now() - started),
      totalBytes: this.totalBytes,
      responses: this.evidence,
    };
  }
  private paymentChallenge(
    retrieval: RetrievedDocumentMaybeTruncated,
    evidence: McpResponseEvidence,
    wwwAuthenticate: string | undefined,
  ): McpPaymentChallenge | undefined {
    // A body cut short by the response bound is never parsed, and no record
    // is kept: its hash and size would describe a prefix presented as the
    // body. A complete PAYMENT-REQUIRED header on such a response is lost
    // with it, by design.
    if (retrieval.truncated === true) return undefined;
    // The column CHECK bounds UTF-8 bytes, so cut on whole code points within 200 bytes.
    let contentType = retrieval.contentType;
    if (contentType && Buffer.byteLength(contentType, 'utf8') > 200) {
      let bytes = 0;
      let kept = '';
      for (const point of contentType) {
        bytes += Buffer.byteLength(point, 'utf8');
        if (bytes > 200) break;
        kept += point;
      }
      contentType = kept;
    }
    let observation: ReturnType<typeof extractPaymentChallenge>;
    try {
      observation = extractPaymentChallenge(
        paymentChallengeResponse(retrieval, contentType, wwwAuthenticate),
      );
      // Deeply nested unrecognized fields survive extraction but overflow the
      // stack when the record is serialized later, outside any savepoint.
      if (observation) JSON.stringify(observation);
    } catch (error) {
      // The challenge record is supplementary evidence. A publisher-controlled
      // value it cannot represent must never fail the inspection itself.
      console.warn('Payment challenge extraction failed', {
        code: 'PAYMENT_CHALLENGE_EXTRACT_FAILED',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return undefined;
    }
    return observation
      ? {
          bodySha256: evidence.sha256,
          bodyBytes: evidence.bytes,
          ...(contentType ? { contentType } : {}),
          observation,
        }
      : undefined;
  }
  private authResult(
    endpoint: URL,
    sources: McpCandidateResult['sources'],
    failure: Extract<RpcResult, { ok: false }>,
    started: number,
  ): McpCandidateResult {
    const httpStatus =
      failure.httpStatus === 403 || failure.httpStatus === 402
        ? failure.httpStatus
        : 401;
    return {
      endpoint: endpoint.href,
      sources,
      probePolicy: 'inspected',
      status:
        httpStatus === 403
          ? 'forbidden'
          : httpStatus === 402
            ? 'payment_required'
            : 'auth_required',
      targetOrigin: endpoint.origin,
      syntacticallyEligible: true,
      auth: {
        httpStatus,
        wwwAuthenticate: failure.wwwAuthenticate,
        insufficientScope:
          httpStatus === 403 &&
          /error\s*=\s*"?insufficient_scope"?/i.test(
            failure.wwwAuthenticate ?? '',
          ),
      },
      ...(failure.paymentChallenge
        ? { paymentChallenge: failure.paymentChallenge }
        : {}),
      network: this.network(started),
    };
  }
  private failureResult(
    endpoint: URL,
    sources: McpCandidateResult['sources'],
    failure: Extract<RpcResult, { ok: false }>,
    started: number,
  ): McpCandidateResult {
    const status =
      failure.code === 'TARGET_BLOCKED'
        ? 'blocked'
        : failure.kind === 'not_mcp'
          ? 'not_mcp'
          : failure.kind === 'network'
            ? 'unreachable'
            : 'protocol_error';
    return {
      endpoint: endpoint.href,
      sources,
      probePolicy: 'inspected',
      status,
      targetOrigin: endpoint.origin,
      syntacticallyEligible: true,
      error: { code: failure.code, message: failure.message },
      network: this.network(started),
    };
  }
  private protocolFailure(
    endpoint: URL,
    sources: McpCandidateResult['sources'],
    code: string,
    message: string,
    started: number,
    status: 'protocol_error' | 'unsupported_version' = 'protocol_error',
  ): McpCandidateResult {
    return {
      endpoint: endpoint.href,
      sources,
      probePolicy: 'inspected',
      status,
      targetOrigin: endpoint.origin,
      syntacticallyEligible: true,
      error: { code, message },
      network: this.network(started),
    };
  }
}
