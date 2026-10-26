import { createHash } from 'node:crypto';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseDocument } from 'yaml';
import type {
  ArdSummary,
  DiscoveryValidation,
  OpenApiDocumentObservation,
  OpenApiObservation,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSchemaSlot,
  ValidationIssue,
} from '@interfacedelta/contracts';
import { projectJsonSchema } from '@interfacedelta/schema-compatibility';
import officialSchema from '../developer-api/schemas/oas-3.1-schema.json';
import type {
  RetrievalResult,
  SafeOutboundClient,
} from '../scanner/outbound-boundary';
import { canonicalJson, canonicalSha256 } from '../passport/canonical-json';
import { extractOperationPaymentInfo } from './payment-info';

export const OPENAPI_MEDIA_TYPES = [
  'application/vnd.oai.openapi',
  'application/vnd.oai.openapi+json',
  'application/vnd.oai.openapi+yaml',
] as const;
export const OPENAPI_LIMITS = {
  maxDocuments: 3,
  maxDocumentBytes: 1024 * 1024,
  maxAggregateBytes: 2 * 1024 * 1024,
  maxOperations: 500,
  maxParameters: 2_000,
  maxSchemaSlots: 2_000,
  maxRefDepth: 16,
  maxYamlAliases: 32,
  maxString: 512,
} as const;
export const OPENAPI_SCHEMA_PIN = {
  name: 'OpenAPI 3.1.x document schema',
  version: '3.1',
  revision: '2025-09-15',
  file: 'https://spec.openapis.org/oas/3.1/schema/2025-09-15',
  sha256: 'd0a3955182364c7b5fdebfd0583ecad259a870b4a2fe86a1b0fe8785f8224fed',
  dialect: 'https://json-schema.org/draft/2020-12/schema',
  schemaObjectDialect: 'https://spec.openapis.org/oas/3.1/dialect/2024-11-10',
} as const;
export const INTERFACEDELTA_CAPABILITY_EXTENSION =
  'x-interfacedelta-capability' as const;
type Obj = Record<string, unknown>;
type Declaration = ArdSummary['declarations'][number];
const methods = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;
const object = (v: unknown): Obj | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Obj)
    : undefined;
const text = (v: unknown) =>
  typeof v === 'string' ? v.slice(0, OPENAPI_LIMITS.maxString) : undefined;
const sha256 = (body: Uint8Array) =>
  createHash('sha256').update(body).digest('hex');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addFormat('media-range', true);
const structuralSchema = JSON.parse(
  JSON.stringify(officialSchema),
  (key, value) => (key === '$dynamicRef' ? undefined : value),
);
const validator = ajv.compile(structuralSchema);
const validation = (valid: boolean): DiscoveryValidation => ({
  valid,
  schemaName: OPENAPI_SCHEMA_PIN.name,
  schemaVersion: OPENAPI_SCHEMA_PIN.version,
  schemaRevision: OPENAPI_SCHEMA_PIN.revision,
  schemaFile: OPENAPI_SCHEMA_PIN.file,
  schemaSha256: OPENAPI_SCHEMA_PIN.sha256,
  errors: (validator.errors ?? [])
    .slice(0, 64)
    .map((e: ErrorObject): ValidationIssue => ({
      code: e.keyword,
      instancePath: e.instancePath,
      schemaPath: e.schemaPath,
      message: e.message ?? 'Validation failed.',
      params: e.params as Record<string, unknown>,
    })),
});
export function isOpenApiMediaType(value: string): boolean {
  const [base, ...parts] = value.split(';');
  if (
    !OPENAPI_MEDIA_TYPES.includes(
      base!.trim().toLowerCase() as (typeof OPENAPI_MEDIA_TYPES)[number],
    )
  )
    return false;
  const params = new Map(
    parts.map((p) => {
      const [k, ...v] = p.split('=');
      return [
        k!.trim().toLowerCase(),
        v.join('=').trim().replace(/^"|"$/g, ''),
      ];
    }),
  );
  return !params.has('version') || params.get('version') === '3.1';
}
function pointer(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let v: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    const o = object(v),
      key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!o || !Object.hasOwn(o, key)) return undefined;
    v = o[key];
  }
  return v;
}
function resolve(
  root: unknown,
  value: unknown,
  kind: string,
  depth = 0,
  seen = new Set<string>(),
): { value?: Obj; limitations: string[] } {
  const o = object(value);
  if (!o) return { limitations: [`OPENAPI_${kind}_INVALID`] };
  if (typeof o.$ref !== 'string') return { value: o, limitations: [] };
  const ref = o.$ref;
  if (!ref.startsWith('#/'))
    return { limitations: ['OPENAPI_EXTERNAL_REF_NOT_RESOLVED'] };
  if (depth >= OPENAPI_LIMITS.maxRefDepth || seen.has(ref))
    return { limitations: ['OPENAPI_LOCAL_REF_CYCLE_OR_DEPTH'] };
  const found = pointer(root, ref);
  if (found === undefined)
    return { limitations: ['OPENAPI_LOCAL_REF_UNRESOLVED'] };
  const next = new Set(seen);
  next.add(ref);
  return resolve(root, found, kind, depth + 1, next);
}
const unsupportedKeywords = new Set([
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'prefixItems',
  'readOnly',
  'writeOnly',
  'discriminator',
]);
function schema(root: unknown, value: unknown) {
  if (value === undefined)
    return { complete: true, limitations: [] as string[] };
  const r = resolve(root, value, 'SCHEMA');
  if (!r.value) return { complete: false, limitations: r.limitations };
  const limits = [...r.limitations],
    stack: unknown[] = [r.value];
  let nodes = 0;
  while (stack.length) {
    const v = stack.pop();
    if (++nodes > 2000) {
      limits.push('OPENAPI_SCHEMA_ANALYSIS_LIMIT');
      break;
    }
    if (Array.isArray(v)) {
      stack.push(...v);
      continue;
    }
    const o = object(v);
    if (!o) continue;
    if (typeof o.$ref === 'string' && !o.$ref.startsWith('#/'))
      limits.push('OPENAPI_EXTERNAL_REF_NOT_RESOLVED');
    for (const [k, child] of Object.entries(o)) {
      if (unsupportedKeywords.has(k))
        limits.push(`OPENAPI_SCHEMA_KEYWORD_UNSUPPORTED:${k}`);
      stack.push(child);
    }
  }
  const unique = [...new Set(limits)].sort();
  return {
    sha: canonicalSha256(r.value),
    projection: projectJsonSchema(r.value),
    complete: unique.length === 0,
    limitations: unique,
  };
}
function slot(
  root: unknown,
  mediaType: string,
  value: unknown,
): OpenApiSchemaSlot {
  const e = schema(root, object(value)?.schema);
  return {
    mediaType: mediaType.toLowerCase(),
    schemaSha256: e.sha,
    schemaCompatibility: e.projection,
    complete: e.complete,
    limitationCodes: e.limitations,
  };
}
const slots = (root: unknown, value: unknown) =>
  Object.entries(object(value) ?? {})
    .map(([m, v]) => slot(root, m, v))
    .sort((a, b) => a.mediaType.localeCompare(b.mediaType));
function parameter(
  root: unknown,
  value: unknown,
): OpenApiParameter | undefined {
  const r = resolve(root, value, 'PARAMETER'),
    o = r.value;
  if (
    !o ||
    typeof o.name !== 'string' ||
    !['path', 'query', 'header', 'cookie'].includes(String(o.in))
  )
    return;
  const location = o.in as OpenApiParameter['in'],
    name = location === 'header' ? o.name.toLowerCase() : o.name,
    e = schema(root, o.schema),
    limitations = [...new Set([...r.limitations, ...e.limitations])].sort();
  return {
    key: `${location}:${name}`,
    name: o.name.slice(0, OPENAPI_LIMITS.maxString),
    in: location,
    required: location === 'path' || o.required === true,
    schemaSha256: e.sha,
    schemaCompatibility: e.projection,
    complete: limitations.length === 0,
    limitationCodes: limitations,
  };
}
function operation(
  root: Obj,
  path: string,
  method: string,
  pathItem: Obj,
  raw: unknown,
  counters: { parameters: number; slots: number },
): OpenApiOperation {
  const o = object(raw) ?? {},
    limits: string[] = [],
    byKey = new Map<string, OpenApiParameter>();
  for (const v of [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(o.parameters) ? o.parameters : []),
  ]) {
    if (counters.parameters++ >= OPENAPI_LIMITS.maxParameters) {
      limits.push('OPENAPI_PARAMETER_LIMIT');
      break;
    }
    const p = parameter(root, v);
    if (p) byKey.set(p.key, p);
    else limits.push('OPENAPI_PARAMETER_INVALID_OR_UNRESOLVED');
  }
  const request =
      o.requestBody === undefined
        ? { limitations: [] as string[] }
        : resolve(root, o.requestBody, 'REQUEST_BODY'),
    requestSlots = request.value ? slots(root, request.value.content) : [];
  counters.slots += requestSlots.length;
  const responses: OpenApiOperation['responses'][number][] = [];
  for (const [statusKey, rawResponse] of Object.entries(
    object(o.responses) ?? {},
  ).sort()) {
    const r = resolve(root, rawResponse, 'RESPONSE'),
      content = r.value ? slots(root, r.value.content) : [];
    counters.slots += content.length;
    responses.push({
      statusKey,
      descriptionPresent: typeof r.value?.description === 'string',
      content,
    });
    limits.push(...r.limitations, ...content.flatMap((x) => x.limitationCodes));
  }
  if (counters.slots > OPENAPI_LIMITS.maxSchemaSlots)
    limits.push('OPENAPI_SCHEMA_SLOT_LIMIT');
  limits.push(
    ...request.limitations,
    ...requestSlots.flatMap((x) => x.limitationCodes),
  );
  const rawExtension =
      o[INTERFACEDELTA_CAPABILITY_EXTENSION] ??
      o['x-interfacedelta-capability-id'],
    ext = object(rawExtension);
  const explicitCapability =
    typeof rawExtension === 'string'
      ? { id: rawExtension.slice(0, OPENAPI_LIMITS.maxString) }
      : ext && typeof ext.id === 'string'
        ? {
            id: ext.id.slice(0, OPENAPI_LIMITS.maxString),
            requestMediaType: text(ext.requestMediaType)?.toLowerCase(),
            responseStatus: text(ext.responseStatus),
            responseMediaType: text(ext.responseMediaType)?.toLowerCase(),
          }
        : undefined;
  const unique = [...new Set(limits)].sort();
  return {
    key: `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase(),
    path,
    operationId: text(o.operationId),
    summary: text(o.summary),
    tags: Array.isArray(o.tags)
      ? [...new Set(o.tags.filter((x): x is string => typeof x === 'string'))]
          .sort()
          .slice(0, 64)
      : [],
    parameters: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
    requestBody: request.value
      ? { required: request.value.required === true, content: requestSlots }
      : undefined,
    responses,
    securityDeclared: Object.hasOwn(o, 'security'),
    paymentDeclaration: extractOperationPaymentInfo(
      o,
      responses.some((response) => response.statusKey === '402'),
    ),
    explicitCapability,
    complete: unique.length === 0,
    limitationCodes: unique,
  };
}
type Provenance = OpenApiDocumentObservation['provenance'];
const blank = (
  d: { identifier: string; url?: string },
  provenance: Provenance,
  artifactUrl: string,
  status: OpenApiDocumentObservation['status'],
  code: string,
  message: string,
): OpenApiDocumentObservation => ({
  declarationId: d.identifier,
  provenance,
  declaredUrl: d.url,
  artifactUrl,
  status,
  fetched: false,
  servers: [],
  securitySchemes: [],
  topLevelSecurityDeclared: false,
  pathCount: 0,
  operations: [],
  complete: false,
  limitationCodes: [code],
  error: { code, message },
});
export function parseAndNormalizeOpenApi(
  d: { identifier: string; url?: string },
  provenance: Provenance,
  artifactUrl: string,
  body: Buffer,
  contentType?: string,
): OpenApiDocumentObservation {
  let document: unknown,
    serialization: 'json' | 'yaml' = 'json';
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    serialization = 'yaml';
    try {
      const parsed = parseDocument(body.toString('utf8'), {
        prettyErrors: false,
        strict: true,
        uniqueKeys: true,
      });
      if (parsed.errors.length) throw parsed.errors[0];
      document = parsed.toJS({ maxAliasCount: OPENAPI_LIMITS.maxYamlAliases });
    } catch {
      return {
        ...blank(
          d,
          provenance,
          artifactUrl,
          'malformed',
          'OPENAPI_MALFORMED_SERIALIZATION',
          'Artifact is neither bounded valid JSON nor safe YAML.',
        ),
        fetched: provenance !== 'ard_inline',
        bytes: body.length,
        contentType,
        sha256: sha256(body),
      };
    }
  }
  const root = object(document),
    version = text(root?.openapi);
  if (!version || !/^3\.1\.\d+$/.test(version))
    return {
      ...blank(
        d,
        provenance,
        artifactUrl,
        'unsupported_version',
        'OPENAPI_UNSUPPORTED_VERSION',
        version
          ? `OpenAPI ${version} is outside supported 3.1.x.`
          : 'No supported OpenAPI version was declared.',
      ),
      fetched: provenance !== 'ard_inline',
      serialization,
      bytes: body.length,
      contentType,
      sha256: sha256(body),
      openapiVersion: version,
    };
  const valid = validator(root);
  if (!valid)
    return {
      ...blank(
        d,
        provenance,
        artifactUrl,
        'invalid',
        'OPENAPI_SCHEMA_INVALID',
        'Document fails the pinned official OpenAPI 3.1 schema.',
      ),
      fetched: provenance !== 'ard_inline',
      serialization,
      bytes: body.length,
      contentType,
      sha256: sha256(body),
      openapiVersion: version,
      validation: validation(false),
    };
  const counters = { parameters: 0, slots: 0 },
    operations: OpenApiOperation[] = [],
    limits: string[] = [],
    paths = object(root!.paths) ?? {};
  for (const path of Object.keys(paths).sort()) {
    const item = resolve(root, paths[path], 'PATH_ITEM');
    if (!item.value) {
      limits.push(...item.limitations);
      continue;
    }
    for (const method of methods) {
      if (item.value[method] === undefined) continue;
      if (operations.length >= OPENAPI_LIMITS.maxOperations) {
        limits.push('OPENAPI_OPERATION_LIMIT');
        break;
      }
      operations.push(
        operation(
          root!,
          path,
          method,
          item.value,
          item.value[method],
          counters,
        ),
      );
    }
  }
  limits.push(...operations.flatMap((x) => x.limitationCodes));
  const servers = (Array.isArray(root!.servers) ? root!.servers : [])
      .map(object)
      .filter((x): x is Obj => !!x)
      .flatMap((x) =>
        typeof x.url === 'string' ? [server(x.url, artifactUrl)] : [],
      ),
    schemes = Object.entries(
      object(object(root!.components)?.securitySchemes) ?? {},
    )
      .map(([name, v]) => ({
        name,
        type:
          text(resolve(root, v, 'SECURITY_SCHEME').value?.type) ?? 'unknown',
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    unique = [...new Set(limits)].sort();
  return {
    declarationId: d.identifier,
    provenance,
    declaredUrl: d.url,
    artifactUrl,
    status: 'valid',
    fetched: provenance !== 'ard_inline',
    serialization,
    openapiVersion: version,
    title: text(object(root!.info)?.title),
    apiVersion: text(object(root!.info)?.version),
    sha256: sha256(body),
    bytes: body.length,
    contentType,
    validation: validation(true),
    servers,
    securitySchemes: schemes,
    topLevelSecurityDeclared: Object.hasOwn(root!, 'security'),
    pathCount: Object.keys(paths).length,
    operations,
    complete: unique.length === 0,
    limitationCodes: unique,
  };
}
function server(url: string, artifactUrl: string) {
  if (/\{[^}]+\}/.test(url)) return { url, concrete: false };
  try {
    const u = new URL(url, artifactUrl);
    return u.protocol === 'https:'
      ? { url, concrete: true, resolvedOrigin: u.origin }
      : { url, concrete: true };
  } catch {
    return { url, concrete: false };
  }
}
function failure(
  d: Declaration,
  provenance: Provenance,
  url: string,
  r: Extract<RetrievalResult, { ok: false }>,
) {
  const status =
    r.code === 'TARGET_BLOCKED'
      ? 'blocked'
      : r.code === 'RESPONSE_TOO_LARGE'
        ? 'too_large'
        : 'unreachable';
  return {
    ...blank(d, provenance, url, status, `OPENAPI_${r.code}`, r.message),
    fetched: true,
  };
}
export async function observeOpenApi(
  origin: URL,
  summary: ArdSummary | undefined,
  client: SafeOutboundClient,
  directOpenApiUrl?: URL,
): Promise<OpenApiObservation> {
  const directId = 'urn:interfacedelta:user-supplied:openapi',
    directDeclaration: Declaration | undefined = directOpenApiUrl
      ? {
          identifier: directId,
          displayName: 'User-supplied OpenAPI document',
          type: 'application/vnd.oai.openapi+json;version=3.1',
          url: directOpenApiUrl.href,
        }
      : undefined,
    published = (summary?.declarations ?? [])
      .filter((x) => isOpenApiMediaType(x.type))
      .sort((a, b) => a.identifier.localeCompare(b.identifier)),
    declarations = [
      ...(directDeclaration ? [directDeclaration] : []),
      ...published.filter(
        (item) => !directOpenApiUrl || item.url !== directOpenApiUrl.href,
      ),
    ],
    inline = new Map(
      (summary?.openApiInline ?? []).map((x) => [x.identifier, x.data]),
    ),
    documents: OpenApiDocumentObservation[] = [];
  let fetched = 0,
    aggregate = 0;
  for (const d of declarations.slice(0, OPENAPI_LIMITS.maxDocuments)) {
    const provenance: Provenance =
      d.identifier === directId ? 'user_supplied' : 'ard_url';
    const data = inline.get(d.identifier) ?? d.data;
    if (data) {
      const body = Buffer.from(canonicalJson(data));
      aggregate += body.length;
      documents.push(
        aggregate > OPENAPI_LIMITS.maxAggregateBytes
          ? blank(
              d,
              'ard_inline',
              `inline:${d.identifier}`,
              'too_large',
              'OPENAPI_AGGREGATE_LIMIT',
              'Aggregate OpenAPI byte limit reached.',
            )
          : parseAndNormalizeOpenApi(
              d,
              'ard_inline',
              `inline:${d.identifier}`,
              body,
              'application/json',
            ),
      );
      continue;
    }
    if (!d.url) continue;
    if (aggregate >= OPENAPI_LIMITS.maxAggregateBytes) {
      documents.push(
        blank(
          d,
          provenance,
          d.url,
          'too_large',
          'OPENAPI_AGGREGATE_LIMIT',
          'Aggregate OpenAPI byte limit reached.',
        ),
      );
      continue;
    }
    let url: URL;
    try {
      url = new URL(d.url, origin);
    } catch {
      documents.push(
        blank(
          d,
          provenance,
          d.url,
          'blocked',
          'OPENAPI_DECLARED_URL_INVALID',
          'Declared OpenAPI URL is invalid.',
        ),
      );
      continue;
    }
    if (url.origin !== origin.origin) {
      documents.push(
        blank(
          d,
          provenance,
          url.href,
          'declared_not_fetched',
          'OPENAPI_CROSS_ORIGIN_NOT_FETCHED',
          'Cross-origin OpenAPI declarations are recorded but not fetched.',
        ),
      );
      continue;
    }
    const r = await client.get(url, {
      maxBodyBytes: Math.min(
        OPENAPI_LIMITS.maxDocumentBytes,
        OPENAPI_LIMITS.maxAggregateBytes - aggregate,
      ),
      accept:
        'application/vnd.oai.openapi+json, application/vnd.oai.openapi+yaml, application/json, application/yaml, text/yaml',
    });
    fetched++;
    if (!r.ok) {
      documents.push(failure(d, provenance, url.href, r));
      continue;
    }
    // Only documents count toward the aggregate budget: an error page (even a
    // truncated one) must not starve a later declared document.
    if (r.httpStatus >= 200 && r.httpStatus < 300) aggregate += r.body.length;
    if (r.httpStatus === 404)
      documents.push({
        ...blank(
          d,
          provenance,
          url.href,
          'not_found',
          'OPENAPI_HTTP_404',
          'Declared OpenAPI artifact returned HTTP 404.',
        ),
        fetched: true,
      });
    else if (r.httpStatus < 200 || r.httpStatus >= 300)
      documents.push({
        ...blank(
          d,
          provenance,
          url.href,
          'unreachable',
          'OPENAPI_HTTP_ERROR',
          `Declared OpenAPI artifact returned HTTP ${r.httpStatus}.`,
        ),
        fetched: true,
      });
    else
      documents.push(
        parseAndNormalizeOpenApi(
          d,
          provenance,
          r.finalUrl,
          r.body,
          r.contentType,
        ),
      );
  }
  const omitted = Math.max(0, declarations.length - documents.length);
  return {
    totalDeclared: declarations.length,
    totalFetched: fetched,
    totalOmitted: omitted,
    complete: omitted === 0 && documents.every((x) => x.complete),
    documents,
  };
}
