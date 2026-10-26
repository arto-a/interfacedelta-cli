import { z } from 'zod';
import type { EconomicPaymentChallengeObservation } from './economic-payment-challenge';

/**
 * Canonical positive provenance classes. These values are additive aliases for
 * existing InterfaceDelta semantics; persisted Capability Intelligence values
 * are never rewritten through this contract.
 */
export const POSITIVE_EVIDENCE_CLASSES = [
  'DIRECTLY_OBSERVED',
  'PUBLISHER_DECLARED',
  'INTERFACEDELTA_DERIVED',
  'INTERFACEDELTA_INFERRED',
] as const;
export type PositiveEvidenceClass = (typeof POSITIVE_EVIDENCE_CLASSES)[number];
export const positiveEvidenceClassSchema = z.enum(POSITIVE_EVIDENCE_CLASSES);

/** An evidence gap is a separate dimension and always carries structured why. */
export const GAP_STATEMENT_CLASS = 'NOT_OBSERVED_OR_NOT_FETCHED' as const;
export type GapStatement<
  Code extends string = string,
  ReasonCode extends string = string,
> = {
  readonly class: typeof GAP_STATEMENT_CLASS;
  readonly code: Code;
  readonly reasonCode: ReasonCode;
};

/** Existing persisted Capability Intelligence gap vocabularies, byte-identical. */
export const CAPABILITY_GAP_CODES = [
  'OUTPUT_STRUCTURE_NOT_DECLARED_OR_OBSERVED',
  'AUTHENTICATED_ACCESS_NOT_VERIFIED',
  'CAPABILITY_EXECUTION_NOT_VERIFIED',
  'QUERY_AUTHORITY_NOT_ESTABLISHED',
  'SOURCE_CAPABILITY_INVENTORY_INCOMPLETE',
  'CAPABILITY_DETAIL_PROJECTION_BOUNDED',
] as const;
export type CapabilityGapCode = (typeof CAPABILITY_GAP_CODES)[number];
export const CAPABILITY_GAP_REASON_CODES = [
  'OUTPUT_SCHEMA_ABSENT_FROM_RETAINED_CAPABILITY',
  'AUTHENTICATED_FLOW_NOT_PERFORMED',
  'CAPABILITY_METADATA_OBSERVED_WITHOUT_EXECUTION',
  'AUTHORITY_REQUIRED_BY_QUERY_NOT_ESTABLISHED',
  'PASSPORT_FINGERPRINT_INCOMPLETE',
  'BOUNDED_INFERENCE_DETAIL_PROJECTION',
] as const;
export type CapabilityGapReasonCode =
  (typeof CAPABILITY_GAP_REASON_CODES)[number];

/** Historical HTML/read-model spelling; intentionally remains byte-identical. */
export const LEGACY_READ_MODEL_EVIDENCE_CLASSES = [
  'directly_observed',
  'publisher_declared',
  'interfacedelta_derived',
  'not_observed_or_fetched',
] as const;
export type LegacyReadModelEvidenceClass =
  (typeof LEGACY_READ_MODEL_EVIDENCE_CLASSES)[number];
export type LegacyCompatibleCanonicalEvidenceClass =
  | Exclude<PositiveEvidenceClass, 'INTERFACEDELTA_INFERRED'>
  | typeof GAP_STATEMENT_CLASS;

const LEGACY_TO_CANONICAL_EVIDENCE = {
  directly_observed: 'DIRECTLY_OBSERVED',
  publisher_declared: 'PUBLISHER_DECLARED',
  interfacedelta_derived: 'INTERFACEDELTA_DERIVED',
  not_observed_or_fetched: GAP_STATEMENT_CLASS,
} as const satisfies Record<
  LegacyReadModelEvidenceClass,
  LegacyCompatibleCanonicalEvidenceClass
>;

const CANONICAL_TO_LEGACY_EVIDENCE = {
  DIRECTLY_OBSERVED: 'directly_observed',
  PUBLISHER_DECLARED: 'publisher_declared',
  INTERFACEDELTA_DERIVED: 'interfacedelta_derived',
  NOT_OBSERVED_OR_NOT_FETCHED: 'not_observed_or_fetched',
} as const satisfies Record<
  LegacyCompatibleCanonicalEvidenceClass,
  LegacyReadModelEvidenceClass
>;

export function toCanonicalEvidenceClass(
  value: LegacyReadModelEvidenceClass,
): LegacyCompatibleCanonicalEvidenceClass {
  return LEGACY_TO_CANONICAL_EVIDENCE[value];
}

export function toLegacyReadModelEvidenceClass(
  value: LegacyCompatibleCanonicalEvidenceClass,
): LegacyReadModelEvidenceClass {
  return CANONICAL_TO_LEGACY_EVIDENCE[value];
}

const discoveryText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);
const discoverySha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const USER_SUPPLIED_SEED_DISCOVERY_BASIS = 'user_supplied_seed' as const;

export const discoverySourceObservationSchema = z
  .object({
    class: z.enum(['DIRECTLY_OBSERVED', 'INTERFACEDELTA_DERIVED']),
    sourceKind: discoveryText(120),
    sourceRecordRef: discoveryText(1_024),
    payloadHash: discoverySha256Schema,
    sourceObservedAt: z.string().datetime(),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type DiscoverySourceObservation = z.infer<
  typeof discoverySourceObservationSchema
>;

export const discoveryCandidateClaimSchema = z
  .object({
    /** NULL means this edge asserts no semantic candidate/service claim. */
    class: z.enum(['PUBLISHER_DECLARED', 'INTERFACEDELTA_DERIVED']).nullable(),
    declaringParty: z
      .object({
        type: discoveryText(120),
        identifier: discoveryText(1_024),
      })
      .strict()
      .nullable(),
    subjectRef: discoveryText(1_024),
    extractionRule: discoveryText(256),
    extractionVersion: discoveryText(120),
    extractionPath: discoveryText(2_048),
  })
  .strict()
  .refine((value) => value.class !== null || value.declaringParty === null, {
    message: 'Evidence with no semantic claim cannot name a declaring party.',
    path: ['declaringParty'],
  });
export type DiscoveryCandidateClaim = z.infer<
  typeof discoveryCandidateClaimSchema
>;

export const discoveryGapStatementSchema = z
  .object({
    class: z.literal(GAP_STATEMENT_CLASS),
    code: discoveryText(120),
    reasonCode: discoveryText(120),
  })
  .strict();

/**
 * Provenance for the exact SourceSnapshot -> Candidate edge. Source artifact
 * observation, candidate claim, and an optional gap remain distinct dimensions.
 */
export const discoveryCandidateEvidenceSchema = z
  .object({
    sourceObservation: discoverySourceObservationSchema,
    claim: discoveryCandidateClaimSchema,
    absence: discoveryGapStatementSchema.optional(),
    discoveryBasis: discoveryText(256),
    ingestedAt: z.string().datetime(),
    parentPassportObservationId: z.string().uuid().optional(),
    parentPassportArtifactRef: discoveryText(1_024).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.parentPassportArtifactRef === undefined ||
      value.parentPassportObservationId !== undefined,
    'A parent Passport artifact reference requires its observation ID.',
  )
  .refine(
    (value) =>
      (value.claim.class === null) ===
      (value.discoveryBasis === USER_SUPPLIED_SEED_DISCOVERY_BASIS),
    {
      message:
        'Only user-supplied seed evidence has no semantic claim, and user-supplied seed evidence cannot carry a positive claim.',
      path: ['claim', 'class'],
    },
  );
export type DiscoveryCandidateEvidence = z.infer<
  typeof discoveryCandidateEvidenceSchema
>;

// The MCP authorization server's issuer is deployment configuration, not a
// compiled constant.
export const MCP_RESOURCE = 'https://interfacedelta.com/mcp';
/** Exact OAuth Resource Indicator for fresh inspection and durable recording. */
export const MCP_INSPECTION_RESOURCE = 'https://interfacedelta.com/mcp/inspect';
export const MCP_READ_SCOPE = 'passport:read';

export const healthResponseSchema = z.object({
  service: z.string().min(1),
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const inspectionUrlTypeSchema = z.enum([
  'auto',
  'service',
  'mcp',
  'openapi',
  'a2a',
  'ard',
]);
export type InspectionUrlType = z.infer<typeof inspectionUrlTypeSchema>;

export const inspectionRequestSchema = z
  .object({
    url: z
      .string({ required_error: 'A URL is required.' })
      .min(1, 'A URL is required.'),
    type: inspectionUrlTypeSchema.default('auto'),
    mcpEndpoint: z.string().min(1).optional(),
  })
  .strict();
export type InspectionRequest = z.infer<typeof inspectionRequestSchema>;

/** JSON Schema representation shared by OpenAPI and contract-equivalence tests. */
export const inspectionRequestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', format: 'uri', pattern: '^https://' },
    type: {
      type: 'string',
      enum: ['auto', 'service', 'mcp', 'openapi', 'a2a', 'ard'],
    },
    mcpEndpoint: { type: 'string', format: 'uri', pattern: '^https://' },
  },
} as const;

/** Monitor creation: an inspection request plus the optional page to watch. */
export const monitorRequestJsonSchema = {
  ...inspectionRequestJsonSchema,
  properties: {
    ...inspectionRequestJsonSchema.properties,
    watchPage: {
      type: 'boolean',
      description:
        'Also watch the submitted page (a same-origin path other than /) for declarative WebMCP tools. The homepage is always scanned. Query and fragment are never kept. The path becomes part of the target’s shared history, readable by anyone with a Passport or observation link and kept after account deletion, so never watch a path containing a token, private share link or personal data; paths with a credential segment such as token= are refused with INVALID_TARGET.',
    },
  },
} as const;

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
  'DISCOVERY_POLICY_LIMITED',
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
  readonly ardVersion?: 'v0.91' | 'predecessor';
  readonly predecessorFallbackUsed?: boolean;
  readonly conformanceWarnings?: readonly string[];
  readonly mcpServerCardUrls: readonly string[];
  readonly openApiUrls?: readonly string[];
  readonly openApiInline?: readonly {
    readonly identifier: string;
    readonly data: Readonly<Record<string, unknown>>;
  }[];
  readonly mcpServerCardInline?: readonly {
    readonly identifier: string;
    readonly data: Readonly<Record<string, unknown>>;
  }[];
  readonly sources?: readonly {
    readonly kind: 'well_known' | 'rel' | 'predecessor';
    readonly url: string;
    readonly status: DiscoveryStatus;
    readonly entries?: number;
  }[];
  readonly relDiscovery?: {
    readonly rootUrl: string;
    readonly finalUrl?: string;
    readonly status: string;
    readonly linksFound: number;
    readonly linksUsed: number;
    readonly truncated: boolean;
  };
  readonly conflicts?: readonly {
    readonly identifier: string;
    readonly sourceUrls: readonly string[];
  }[];
  readonly jsonLd?: {
    readonly baseContextApplied: true;
    readonly coreTermIris: readonly string[];
    readonly extensionTermIris: readonly string[];
    readonly externalContextsNotResolved: readonly string[];
    readonly coreTermsComplete: boolean;
  };
  readonly declarations: readonly {
    readonly identifier: string;
    readonly displayName: string;
    readonly type: string;
    readonly url?: string;
    readonly data?: Readonly<Record<string, unknown>>;
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

export type OpenApiDocumentStatus =
  | 'valid'
  | 'invalid'
  | 'unsupported_version'
  | 'malformed'
  | 'not_found'
  | 'unreachable'
  | 'blocked'
  | 'too_large'
  | 'declared_not_fetched';

export interface OpenApiSchemaSlot {
  readonly mediaType: string;
  readonly schemaSha256?: string;
  readonly schemaCompatibility?: unknown;
  readonly complete: boolean;
  readonly limitationCodes: readonly string[];
}

export interface OpenApiParameter {
  readonly key: string;
  readonly name: string;
  readonly in: 'path' | 'query' | 'header' | 'cookie';
  readonly required: boolean;
  readonly schemaSha256?: string;
  readonly schemaCompatibility?: unknown;
  readonly complete: boolean;
  readonly limitationCodes: readonly string[];
}

/**
 * MPP service discovery for the "Payment" HTTP authentication scheme. Only the
 * per-operation `x-payment-info` extension is read; `x-service-info` is not.
 */
export const OPENAPI_PAYMENT_DISCOVERY_SPECIFICATION = {
  repository: 'https://github.com/tempoxyz/mpp-specs',
  revision: '08e7dd873a69866ae2cde74678fc2eaf6d72d22b',
  document: 'specs/extensions/draft-payment-discovery-01.md',
  draft: 'draft-payment-discovery-01',
} as const;
export const OPENAPI_PAYMENT_REJECTION_CODES = [
  'extension_not_an_object',
  'offers_not_an_array',
  'offers_empty',
  'offer_not_an_object',
  'intent_missing',
  'method_missing',
  'amount_missing',
  'amount_not_a_string',
  'amount_not_canonical_digits',
  'currency_not_a_string',
  'description_not_a_string',
  'no_402_response_declared',
] as const;
export type OpenApiPaymentRejectionCode =
  (typeof OPENAPI_PAYMENT_REJECTION_CODES)[number];
/** One offer exactly as the publisher wrote it, bounded; never paid or verified. */
export interface OpenApiPaymentOffer {
  readonly intent?: string;
  readonly method?: string;
  /** Verbatim digits in the currency's smallest unit; `null` declares dynamic pricing. */
  readonly amount?: string | null;
  readonly currency?: string;
  readonly description?: string;
}
export interface OpenApiPaymentDeclaration {
  readonly specification: typeof OPENAPI_PAYMENT_DISCOVERY_SPECIFICATION;
  readonly evidenceClass: 'publisher_declared';
  readonly form: 'single_offer' | 'multi_offer';
  readonly offers: readonly OpenApiPaymentOffer[];
  readonly offersTruncated: boolean;
  /** The spec requires a payable operation to declare a 402 response. */
  readonly declares402Response: boolean;
  readonly rejections: readonly {
    readonly code: OpenApiPaymentRejectionCode;
    readonly offerIndex?: number;
  }[];
}

export interface OpenApiOperation {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly parameters: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly required: boolean;
    readonly content: readonly OpenApiSchemaSlot[];
  };
  readonly responses: readonly {
    readonly statusKey: string;
    readonly descriptionPresent: boolean;
    readonly content: readonly OpenApiSchemaSlot[];
  }[];
  readonly securityDeclared: boolean;
  readonly paymentDeclaration?: OpenApiPaymentDeclaration;
  readonly explicitCapability?: {
    readonly id: string;
    readonly requestMediaType?: string;
    readonly responseStatus?: string;
    readonly responseMediaType?: string;
  };
  readonly complete: boolean;
  readonly limitationCodes: readonly string[];
}

export interface OpenApiDocumentObservation {
  readonly declarationId: string;
  readonly provenance: 'user_supplied' | 'ard_url' | 'ard_inline';
  readonly declaredUrl?: string;
  readonly artifactUrl: string;
  readonly status: OpenApiDocumentStatus;
  readonly fetched: boolean;
  readonly serialization?: 'json' | 'yaml';
  readonly openapiVersion?: string;
  readonly title?: string;
  readonly apiVersion?: string;
  readonly sha256?: string;
  readonly bytes?: number;
  readonly contentType?: string;
  readonly validation?: DiscoveryValidation;
  readonly servers: readonly {
    readonly url: string;
    readonly concrete: boolean;
    readonly resolvedOrigin?: string;
  }[];
  readonly securitySchemes: readonly {
    readonly name: string;
    readonly type: string;
  }[];
  readonly topLevelSecurityDeclared: boolean;
  readonly pathCount: number;
  readonly operations: readonly OpenApiOperation[];
  readonly complete: boolean;
  readonly limitationCodes: readonly string[];
  readonly error?: { readonly code: string; readonly message: string };
}

export interface OpenApiObservation {
  readonly totalDeclared: number;
  readonly totalFetched: number;
  readonly totalOmitted: number;
  readonly complete: boolean;
  readonly documents: readonly OpenApiDocumentObservation[];
}

export interface DiscoveryReport {
  readonly inputUrl: string;
  readonly origin: string;
  readonly inspectedAt: string;
  readonly submitted?: {
    readonly url: string;
    readonly requestedType: InspectionUrlType;
    readonly resolvedType: Exclude<InspectionUrlType, 'auto'>;
    readonly directlyInspected?: 'mcp' | 'openapi' | 'a2a' | 'ard';
  };
  readonly ard: DiscoveryResult<ArdSummary>;
  readonly a2a: DiscoveryResult<A2aSummary>;
  readonly mcp: McpObservation;
  readonly openapi?: OpenApiObservation;
  readonly webmcp?: WebMcpObservation;
}

export const WEBMCP_OBSERVATION_VERSION = 'webmcp-declarative-v1' as const;
/** Pinned source for the declarative markup this observation recognizes. */
export const WEBMCP_SPECIFICATION = {
  repository: 'https://github.com/webmachinelearning/webmcp',
  revision: 'f5645e9aea51eb589599f181d104a2f49430608e',
  document: 'declarative-api-explainer.md',
} as const;
/**
 * A named control associated with a declarative tool form. How a browser
 * compiles controls into a tool input schema is unspecified at the pinned
 * revision, so none is synthesized here.
 */
export interface WebMcpDeclaredControl {
  readonly name: string;
  readonly element: 'input' | 'select' | 'textarea' | 'button';
  readonly type?: string;
  readonly required: boolean;
  readonly description?: string;
  readonly optionCount?: number;
  /** Controls sharing name, element and type, such as a radio group. */
  readonly occurrences: number;
}
export interface WebMcpDeclarativeTool {
  readonly name: string;
  readonly description?: string;
  readonly autoSubmit: boolean;
  readonly method: 'get' | 'post' | 'dialog';
  /** Resolved http(s) form action. Recorded, never requested. */
  readonly action?: string;
  readonly actionRelationship:
    | 'same_origin'
    | 'cross_origin'
    | 'non_http'
    | 'unresolvable'
    | 'not_applicable';
  readonly controls: readonly WebMcpDeclaredControl[];
  readonly controlCount: number;
  readonly controlsTruncated: boolean;
}
/** One HTML page scanned for declarative WebMCP forms; scripts never run. */
export interface WebMcpPageScan {
  readonly observationVersion: typeof WEBMCP_OBSERVATION_VERSION;
  readonly specification: typeof WEBMCP_SPECIFICATION;
  readonly scope:
    'root_html_declarative_forms' | 'submitted_page_html_declarative_forms';
  readonly sourceUrl: string;
  readonly finalUrl?: string;
  readonly status: 'observed' | 'none_observed' | 'not_observed';
  readonly reason?:
    | 'not_found'
    | 'unreachable'
    | 'blocked'
    | 'not_html'
    | 'response_too_large'
    | 'cross_origin_redirect';
  readonly tools: readonly WebMcpDeclarativeTool[];
  readonly toolCount: number;
  readonly toolsTruncated: boolean;
  /** Forms carrying tool attributes without a usable `toolname`. */
  readonly unnamedDeclarations: number;
  readonly warnings: readonly 'DUPLICATE_TOOL_NAME'[];
}
/**
 * The origin root page scan, which the canonical Passport and monitoring use,
 * plus an optional one-time scan of the exact submitted page path.
 */
export interface WebMcpObservation extends WebMcpPageScan {
  readonly scope: 'root_html_declarative_forms';
  /**
   * Present only when a service URL with a non-root path was submitted. It is
   * a one-time inspection: it never enters the Passport, its fingerprints,
   * drift, or monitoring, because recurring scans inspect the origin root.
   */
  readonly submittedPage?: WebMcpPageScan & {
    readonly scope: 'submitted_page_html_declarative_forms';
  };
}

export type McpCandidateSource = 'user_supplied' | 'ard_declared';
export type McpProbePolicy =
  'inspected' | 'declared_not_probed' | 'omitted_limit';
export type McpStatus =
  | 'valid'
  | 'auth_required'
  | 'forbidden'
  | 'payment_required'
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
  readonly inline?: boolean;
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
  /**
   * Set when a non-2xx body exceeded the response cap and only its first
   * bytes were kept. `bytes` and `sha256` then describe that prefix, not the
   * body the endpoint sent.
   */
  readonly truncated?: true;
}

export interface McpToolItem {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchemaPresent: boolean;
  readonly inputSchemaSha256?: string;
  readonly inputSchemaCompatibility?: unknown;
  readonly outputSchemaPresent: boolean;
  readonly outputSchemaSha256?: string;
  readonly outputSchemaCompatibility?: unknown;
  readonly explicitCapabilityId?: string;
  readonly annotationsPresent: boolean;
  /** MCP Apps (SEP-1865) UI resource reference declared in tool `_meta`. */
  readonly uiResourceUri?: string;
  readonly uiResourceUriField?: 'ui.resourceUri' | 'ui/resourceUri';
  /** Declared `_meta.ui.visibility` values, verbatim and bounded. */
  readonly uiVisibility?: readonly string[];
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
    readonly httpStatus: 401 | 402 | 403;
    readonly wwwAuthenticate?: string;
    readonly insufficientScope?: boolean;
  };
  /**
   * The 402 received at first contact, parsed. Publisher-declared only:
   * nothing was paid. Kept out of the Passport and its fingerprint; the raw
   * body is represented only by its hash and length.
   */
  readonly paymentChallenge?: McpPaymentChallenge;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface McpPaymentChallenge {
  /** SHA-256 hex of the exact 402 body bytes received (bounded by the response cap). */
  readonly bodySha256: string;
  readonly bodyBytes: number;
  readonly contentType?: string;
  readonly observation: EconomicPaymentChallengeObservation;
}

export interface McpObservation {
  readonly totalDeclared: number;
  readonly totalInspected: number;
  readonly totalOmitted: number;
  readonly serverCards: readonly ServerCardObservation[];
  readonly candidates: readonly McpCandidateResult[];
}

export const PASSPORT_SCHEMA_VERSION = '0.5.0' as const;
export const PASSPORT_SEMANTIC_PROJECTION_VERSION =
  'passport-semantic-v4' as const;
export const CAPABILITY_SEMANTIC_PROJECTION_VERSION =
  'capability-semantic-v4' as const;
/** Structured Passport versions share one shape; 0.5.0 adds WebMCP. */
export const STRUCTURED_PASSPORT_VERSIONS = {
  '0.4.0': {
    passport: 'passport-semantic-v3',
    capability: 'capability-semantic-v3',
  },
  '0.5.0': {
    passport: PASSPORT_SEMANTIC_PROJECTION_VERSION,
    capability: CAPABILITY_SEMANTIC_PROJECTION_VERSION,
  },
} as const;
export type StructuredPassportVersion =
  keyof typeof STRUCTURED_PASSPORT_VERSIONS;
export const consistencyStatusSchema = z.enum([
  'match',
  'mismatch',
  'indeterminate',
  'not_applicable',
]);
const structuredPassportObject = z.object({
  schemaVersion: z.enum(['0.4.0', '0.5.0']),
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
      protocol: z.enum([
        'ard',
        'a2a',
        'mcp',
        'mcp-server-card',
        'openapi',
        'webmcp',
      ]),
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
        'openapi.document',
        'webmcp.root-html',
        // A target-scope-v2 page-target's watched page. Additive within 0.5.0:
        // no page-less Passport can contain it.
        'webmcp.page-html',
      ]),
      protocol: z.enum(['ard', 'a2a', 'mcp-server-card', 'openapi', 'webmcp']),
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
      sourceProtocol: z.enum([
        'ard',
        'a2a',
        'mcp',
        'mcp-server-card',
        'openapi',
      ]),
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
      kind: z.enum([
        'a2a.skill',
        'mcp.tool',
        'mcp.resource',
        'mcp.prompt',
        'openapi.operation',
        'webmcp.tool',
      ]),
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
      kind: z.enum([
        'a2a.skill',
        'mcp.tool',
        'mcp.resource',
        'mcp.prompt',
        'openapi.operation',
        'webmcp.tool',
      ]),
      protocol: z.enum(['a2a', 'mcp', 'openapi', 'webmcp']),
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
        projectionVersion: z.enum([
          'capability-semantic-v3',
          'capability-semantic-v4',
        ]),
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
      projectionVersion: z.enum([
        'passport-semantic-v3',
        'passport-semantic-v4',
      ]),
      value: z.string(),
      complete: z.boolean(),
    }),
  }),
});
const webMcpValues = new Set([
  'webmcp',
  'webmcp.root-html',
  'webmcp.page-html',
  'webmcp.tool',
]);
function coherentStructuredPassport(
  passport: z.infer<typeof structuredPassportObject>,
  ctx: z.RefinementCtx,
) {
  const expected = STRUCTURED_PASSPORT_VERSIONS[passport.schemaVersion];
  if (passport.fingerprints.passport.projectionVersion !== expected.passport)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fingerprints', 'passport', 'projectionVersion'],
      message: `Passport ${passport.schemaVersion} requires ${expected.passport}.`,
    });
  passport.capabilities.forEach((capability, index) => {
    if (capability.fingerprint.projectionVersion !== expected.capability)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', index, 'fingerprint', 'projectionVersion'],
        message: `Passport ${passport.schemaVersion} requires ${expected.capability}.`,
      });
  });
  if (
    passport.schemaVersion === '0.4.0' &&
    [
      ...passport.protocols.map((item) => item.protocol),
      ...passport.artifacts.flatMap((item) => [item.kind, item.protocol]),
      ...passport.inventoryGroups.map((item) => item.kind),
      ...passport.capabilities.flatMap((item) => [item.kind, item.protocol]),
    ].some((value) => webMcpValues.has(value))
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['schemaVersion'],
      message: 'WebMCP is not part of Passport 0.4.0.',
    });
}
/** Any structured Passport (0.4.0 or 0.5.0); use for retained records. */
export const structuredPassportSchema = structuredPassportObject.superRefine(
  coherentStructuredPassport,
);
/** The current Passport representation only; new observations must match it. */
export const passportSchema = structuredPassportObject.superRefine(
  (passport, ctx) => {
    if (passport.schemaVersion !== PASSPORT_SCHEMA_VERSION)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schemaVersion'],
        message: `Current Passports are ${PASSPORT_SCHEMA_VERSION}.`,
      });
    coherentStructuredPassport(passport, ctx);
  },
);
export type AgentPassport = z.infer<typeof structuredPassportObject>;
export const isStructuredPassport = (passport: {
  schemaVersion: string;
}): passport is AgentPassport =>
  Object.hasOwn(STRUCTURED_PASSPORT_VERSIONS, passport.schemaVersion);
export const passportV020Schema = z
  .object({
    schemaVersion: z.literal('0.2.0'),
    capabilities: z.array(z.unknown()),
    fingerprints: z.object({
      passport: z.object({
        algorithm: z.literal('sha256'),
        canonicalization: z.literal('RFC8785'),
        projectionVersion: z.literal('passport-semantic-v1'),
        value: z.string(),
        complete: z.boolean(),
      }),
    }),
  })
  .passthrough();
export const passportV030Schema = z
  .object({
    schemaVersion: z.literal('0.3.0'),
    capabilities: z.array(z.unknown()),
    fingerprints: z.object({
      passport: z.object({
        algorithm: z.literal('sha256'),
        canonicalization: z.literal('RFC8785'),
        projectionVersion: z.literal('passport-semantic-v2'),
        value: z.string(),
        complete: z.boolean(),
      }),
    }),
  })
  .passthrough();
export const recordedPassportSchema = z.union([
  passportV020Schema,
  passportV030Schema,
  structuredPassportSchema,
]);
export type RecordedAgentPassport = z.infer<typeof recordedPassportSchema>;
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
export * from './economic-payment-challenge';
export * from './economic-payment-challenge-extractor';
