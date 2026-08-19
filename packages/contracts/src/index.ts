import { z } from 'zod';

export const healthResponseSchema = z.object({
  service: z.string().min(1),
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const inspectionRequestSchema = z
  .object({
    url: z
      .string({ required_error: 'A URL is required.' })
      .min(1, 'A URL is required.'),
    mcpEndpoint: z.string().min(1).optional(),
  })
  .strict();
export type InspectionRequest = z.infer<typeof inspectionRequestSchema>;

export const discoveryStatusSchema = z.enum([
  'valid',
  'invalid',
  'not_found',
  'unreachable',
  'blocked',
]);
export type DiscoveryStatus = z.infer<typeof discoveryStatusSchema>;

export const discoveryErrorCodeSchema = z.enum([
  'INVALID_JSON',
  'SCHEMA_INVALID',
  'HTTP_ERROR',
  'DNS_ERROR',
  'CONNECTION_ERROR',
  'TIMEOUT',
  'RESPONSE_TOO_LARGE',
  'UNSUPPORTED_CONTENT_ENCODING',
  'REDIRECT_LIMIT',
  'REDIRECT_LOCATION_INVALID',
  'TARGET_BLOCKED',
]);
export type DiscoveryErrorCode = z.infer<typeof discoveryErrorCodeSchema>;

export interface ValidationIssue {
  readonly code: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface DiscoveryValidation {
  readonly valid: boolean;
  readonly schemaName: string;
  readonly schemaVersion: string;
  readonly schemaRevision: string;
  readonly schemaFile: string;
  readonly schemaSha256: string;
  readonly errors: readonly ValidationIssue[];
}

export interface RedirectObservation {
  readonly from: string;
  readonly to: string;
  readonly httpStatus: number;
}

export interface DiscoveryResult<
  Summary extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly status: DiscoveryStatus;
  readonly discoveryUrl: string;
  readonly finalUrl?: string;
  readonly httpStatus?: number;
  readonly contentType?: string;
  readonly bytes?: number;
  readonly durationMs: number;
  readonly sha256?: string;
  readonly redirects: readonly RedirectObservation[];
  readonly warnings: readonly string[];
  readonly error?: {
    readonly code: DiscoveryErrorCode;
    readonly message: string;
  };
  readonly validation?: DiscoveryValidation;
  readonly summary?: Summary;
}

export interface ArdSummary extends Record<string, unknown> {
  readonly specVersion: string;
  readonly entries: number;
  readonly entryTypes: readonly string[];
  readonly hostPresent: boolean;
  readonly mcpServerCardUrls: readonly string[];
  readonly declarations: readonly {
    readonly identifier: string;
    readonly displayName: string;
    readonly type: string;
    readonly url?: string;
  }[];
}

export interface A2aSummary extends Record<string, unknown> {
  readonly name: string;
  readonly agentVersion: string;
  readonly description?: string;
  readonly skills: readonly {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly tags: readonly string[];
    readonly examples: readonly string[];
    readonly inputModes: readonly string[];
    readonly outputModes: readonly string[];
  }[];
  readonly interfaces: readonly {
    readonly url: string;
    readonly protocolBinding: string;
    readonly protocolVersion: string;
  }[];
  readonly interfaceCount: number;
  readonly securitySchemes: readonly string[];
  readonly capabilities: readonly string[];
  readonly signaturePresent: boolean;
}

export interface DiscoveryReport {
  readonly inputUrl: string;
  readonly origin: string;
  readonly inspectedAt: string;
  readonly ard: DiscoveryResult<ArdSummary>;
  readonly a2a: DiscoveryResult<A2aSummary>;
  readonly mcp: McpObservation;
}

export type McpCandidateSource = 'user_supplied' | 'ard_declared';
export type McpProbePolicy =
  'inspected' | 'declared_not_probed' | 'omitted_limit';
export type McpStatus =
  | 'valid'
  | 'auth_required'
  | 'forbidden'
  | 'not_mcp'
  | 'unsupported_version'
  | 'protocol_error'
  | 'blocked'
  | 'unreachable'
  | 'declared_not_probed'
  | 'configuration_required'
  | 'truncated';

export type ServerCardStatus =
  | 'valid'
  | 'invalid'
  | 'malformed_json'
  | 'not_found'
  | 'unreachable'
  | 'blocked'
  | 'declared_not_fetched';
export interface ServerCardRemoteObservation {
  readonly transport: string;
  readonly remoteEndpoint: string;
  readonly concrete: boolean;
  readonly headersDeclared: boolean;
  readonly probePolicy:
    | 'eligible'
    | 'remote_declared_not_probed'
    | 'configuration_required'
    | 'unsupported_transport';
  readonly reason?: string;
}
export interface ServerCardObservation {
  readonly source: 'ard_declared';
  readonly serverCardUrl: string;
  readonly status: ServerCardStatus;
  readonly fetched: boolean;
  readonly validation?: DiscoveryValidation;
  readonly identity?: {
    readonly name: string;
    readonly version: string;
    readonly description: string;
    readonly title?: string;
  };
  readonly remotes: readonly ServerCardRemoteObservation[];
  readonly network?: {
    readonly httpStatus?: number;
    readonly bytes?: number;
    readonly durationMs: number;
    readonly sha256?: string;
    readonly finalUrl?: string;
    readonly redirects: readonly RedirectObservation[];
  };
  readonly error?: { readonly code: string; readonly message: string };
}

export interface McpResponseEvidence {
  readonly method: string;
  readonly httpStatus: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly sha256: string;
  readonly finalUrl: string;
  readonly redirects: readonly RedirectObservation[];
}

export interface McpToolItem {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchemaPresent: boolean;
  readonly inputSchemaSha256?: string;
  readonly outputSchemaPresent: boolean;
  readonly outputSchemaSha256?: string;
  readonly annotationsPresent: boolean;
}
export interface McpResourceItem {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
}
export interface McpPromptItem {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly argumentCount: number;
}
export interface McpInventory<T> {
  readonly attempted: boolean;
  readonly reason?: 'not_advertised' | 'auth_required' | 'negotiation_failed';
  readonly count: number;
  readonly complete: boolean;
  readonly truncatedReason?:
    | 'page_limit'
    | 'item_limit'
    | 'repeated_cursor'
    | 'malformed_result'
    | 'byte_limit';
  readonly pages: number;
  readonly cache: readonly {
    readonly ttlMs?: number;
    readonly scope?: 'public' | 'private';
  }[];
  readonly items: readonly T[];
  readonly failureCode?: string;
  readonly failureRpcCode?: number;
}

export interface McpCandidateResult {
  readonly endpoint: string;
  readonly sources: readonly McpCandidateSource[];
  readonly probePolicy: McpProbePolicy;
  readonly status: McpStatus;
  readonly targetOrigin: string;
  readonly syntacticallyEligible: boolean;
  readonly serverCardUrl?: string;
  readonly remoteTransport?: 'streamable-http';
  readonly protocol?: {
    readonly era: 'modern' | 'legacy';
    readonly version: string;
    readonly supportedVersions: readonly string[];
    readonly modernDiscoveryAttempted: boolean;
    readonly legacyInitializeAttempted: boolean;
    readonly fallbackReason?: string;
  };
  readonly server?: {
    readonly selfReportedIdentity?: {
      readonly name: string;
      readonly version: string;
      readonly description?: string;
    };
    readonly instructionsPresent: boolean;
    readonly instructionsPreview?: string;
  };
  readonly capabilities?: Readonly<Record<string, boolean>>;
  readonly tools?: McpInventory<McpToolItem>;
  readonly resources?: McpInventory<McpResourceItem>;
  readonly prompts?: McpInventory<McpPromptItem>;
  readonly network?: {
    readonly totalDurationMs: number;
    readonly totalBytes: number;
    readonly responses: readonly McpResponseEvidence[];
  };
  readonly auth?: {
    readonly httpStatus: 401 | 403;
    readonly wwwAuthenticate?: string;
    readonly insufficientScope?: boolean;
  };
  readonly error?: { readonly code: string; readonly message: string };
}

export interface McpObservation {
  readonly totalDeclared: number;
  readonly totalInspected: number;
  readonly totalOmitted: number;
  readonly serverCards: readonly ServerCardObservation[];
  readonly candidates: readonly McpCandidateResult[];
}

export const PASSPORT_SCHEMA_VERSION = '0.2.0' as const;
export const consistencyStatusSchema = z.enum([
  'match',
  'mismatch',
  'indeterminate',
  'not_applicable',
]);
export const passportSchema = z.object({
  schemaVersion: z.literal(PASSPORT_SCHEMA_VERSION),
  subject: z.object({
    origin: z.string().url(),
    hostname: z.string(),
    scheme: z.literal('https'),
    effectivePort: z.literal(443),
    inputUrl: z.string(),
  }),
  observation: z.object({
    inspectedAt: z.string(),
    discoveryReportType: z.literal('agent-passport.discovery-report'),
  }),
  protocols: z.array(
    z.object({
      protocol: z.enum(['ard', 'a2a', 'mcp', 'mcp-server-card']),
      status: z.string(),
      revision: z.string().optional(),
      artifactRefs: z.array(z.string()),
      endpointRefs: z.array(z.string()),
    }),
  ),
  artifacts: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([
        'ard.catalog',
        'a2a.agent-card',
        'mcp.server-card.experimental',
      ]),
      protocol: z.enum(['ard', 'a2a', 'mcp-server-card']),
      url: z.string(),
      status: z.string(),
      validationStatus: z.enum(['valid', 'invalid', 'not_validated']),
      bodySha256: z.string().optional(),
      schemaRevision: z.string().optional(),
      provenance: z.array(z.string()),
    }),
  ),
  endpoints: z.array(
    z.object({
      id: z.string(),
      protocol: z.enum(['a2a', 'mcp']),
      role: z.enum(['a2a.interface', 'mcp.streamable-http']),
      url: z.string(),
      originRelationship: z.enum(['same_origin', 'cross_origin']),
      relationship: z.enum([
        'declared',
        'explicitly_inspected',
        'declared_and_inspected',
      ]),
      declarationSources: z.array(z.string()),
      observationStatus: z.string(),
      protocolVersion: z.string().optional(),
      artifactRefs: z.array(z.string()),
    }),
  ),
  identityAssertions: z.array(
    z.object({
      id: z.string(),
      sourceProtocol: z.enum(['ard', 'a2a', 'mcp', 'mcp-server-card']),
      sourceRef: z.string(),
      assertionType: z.string(),
      field: z.string(),
      value: z.string(),
      trust: z.literal('self_reported'),
    }),
  ),
  accessAssertions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([
        'declared_security_scheme',
        'observed_http_access',
        'configuration_required',
      ]),
      sourceRef: z.string(),
      endpointId: z.string().optional(),
      name: z.string(),
      value: z.string().optional(),
    }),
  ),
  inventoryGroups: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['a2a.skill', 'mcp.tool', 'mcp.resource', 'mcp.prompt']),
      sourceRef: z.string(),
      sourceEndpointId: z.string().optional(),
      attempted: z.boolean(),
      complete: z.boolean(),
      itemCount: z.number().int().nonnegative(),
      truncatedReason: z.string().optional(),
      failureCode: z.string().optional(),
    }),
  ),
  capabilities: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['a2a.skill', 'mcp.tool', 'mcp.resource', 'mcp.prompt']),
      protocol: z.enum(['a2a', 'mcp']),
      protocolKey: z.string(),
      name: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      sourceRef: z.string(),
      sourceEndpointId: z.string().optional(),
      metadata: z.record(z.unknown()),
      inventory: z.object({
        complete: z.boolean(),
        truncatedReason: z.string().optional(),
      }),
      fingerprint: z.object({
        algorithm: z.literal('sha256'),
        canonicalization: z.literal('RFC8785'),
        projectionVersion: z.literal('capability-semantic-v1'),
        value: z.string(),
      }),
      provenance: z.array(z.string()),
    }),
  ),
  consistency: z.object({
    summary: z.object({
      checks: z.number().int(),
      matches: z.number().int(),
      mismatches: z.number().int(),
      indeterminate: z.number().int(),
      notApplicable: z.number().int(),
    }),
    findings: z.array(
      z.object({
        code: z.string(),
        status: consistencyStatusSchema,
        subjectRefs: z.array(z.string()),
        evidenceRefs: z.array(z.string()),
        message: z.string(),
      }),
    ),
  }),
  fingerprints: z.object({
    passport: z.object({
      algorithm: z.literal('sha256'),
      canonicalization: z.literal('RFC8785'),
      projectionVersion: z.literal('passport-semantic-v1'),
      value: z.string(),
      complete: z.boolean(),
    }),
  }),
});
export type AgentPassport = z.infer<typeof passportSchema>;
export type ConsistencyFinding =
  AgentPassport['consistency']['findings'][number];
export interface InspectionResponse extends DiscoveryReport {
  readonly passport: AgentPassport;
}

export const inspectionApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(['INVALID_REQUEST', 'INVALID_TARGET']),
    message: z.string(),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  }),
});
export type InspectionApiError = z.infer<typeof inspectionApiErrorSchema>;
