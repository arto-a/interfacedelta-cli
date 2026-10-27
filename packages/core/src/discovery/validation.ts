import { createHash } from 'node:crypto';
import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type {
  A2aSummary,
  ArdSummary,
  DiscoveryValidation,
  ValidationIssue,
} from '@interfacedelta/contracts';
import ardPredecessorSchema from './schemas/ard-ai-catalog.schema.json';
import ardV091Schema from './schemas/ard-v091-entry.schema.json';
import a2aBundle from './schemas/a2a-v1.schema.json';
import { isOpenApiMediaType } from '../openapi/observe';
import { ARD_NAMESPACE, expandedScalar, interpretArdEntry } from './ard-jsonld';

export const ARD_V091_SCHEMA = {
  name: 'Agentic Resource Discovery ArdManifest',
  version: 'v0.91',
  revision: 'aa3e598bb7752a9175897823234311216acfa864',
  file: 'spec/schemas/ard-entry.schema.json#/$defs/ArdManifest',
  sha256: '011b86d55fd5d2883dffae3f0577d26f5efb56ca866eb079edbc78a628f95499',
} as const;
export const ARD_PREDECESSOR_SCHEMA = {
  name: 'Agentic Resource Discovery AI Catalog predecessor',
  version: '0.9 draft',
  revision: '5fa2f5aef790b478319f6a3b43adf4661b0ed0e0',
  file: 'spec/schemas/ai-catalog.schema.json',
  sha256: 'c55238483a4738e08b250bdd6af1f4dc05a91afe882c649d224d09c19cd8fe09',
} as const;
export const A2A_SCHEMA = {
  name: 'A2A Agent Card',
  version: '1.0',
  revision: '173695755607e884aa9acf8ce4feed90e32727a1',
  file: 'official generated specification/json/a2a.json bundle',
  sha256: '8e16bb6822202d211fbcc0f36cd6d75420780f35975272bd5ed142a5ccf51123',
} as const;

function issues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    code: error.keyword,
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    message: error.message ?? 'Validation failed.',
    params: error.params as Record<string, unknown>,
  }));
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}
const ardV091Validator = createAjv().compile({
  $defs: (ardV091Schema as { $defs: unknown }).$defs,
  $ref: '#/$defs/ArdManifest',
});
const ardPredecessorValidator = createAjv().compile(ardPredecessorSchema);

type JsonSchema = Record<string, unknown> & { title?: string };
const a2aAjv = createAjv();
const a2aDefinitions = (
  a2aBundle as { definitions: Record<string, JsonSchema> }
).definitions;
for (const schema of Object.values(a2aDefinitions)) {
  if (schema.title) {
    const namespace = ['Struct', 'Timestamp', 'Value'].includes(schema.title)
      ? 'google.protobuf'
      : 'lf.a2a.v1';
    a2aAjv.addSchema(
      schema,
      `${namespace}.${schema.title.replaceAll(' ', '')}.jsonschema.json`,
    );
  }
}
const a2aValidator: ValidateFunction = a2aAjv.getSchema(
  'lf.a2a.v1.AgentCard.jsonschema.json',
)!;

function validation(
  valid: boolean,
  validator: ValidateFunction,
  metadata:
    typeof ARD_V091_SCHEMA | typeof ARD_PREDECESSOR_SCHEMA | typeof A2A_SCHEMA,
): DiscoveryValidation {
  return {
    valid,
    schemaName: metadata.name,
    schemaVersion: metadata.version,
    schemaRevision: metadata.revision,
    schemaFile: metadata.file,
    schemaSha256: metadata.sha256,
    errors: issues(validator.errors),
  };
}

export type ArdValidationKind = 'v0.91' | 'predecessor';

type ArdEntryValue = {
  identifier: string;
  displayName: string;
  type: string;
  url?: string;
  data?: Record<string, unknown>;
  representativeQueries?: string[];
};
function validateArdWith(
  document: unknown,
  kind: ArdValidationKind,
): { validation: DiscoveryValidation; summary?: ArdSummary } {
  const validator =
    kind === 'v0.91' ? ardV091Validator : ardPredecessorValidator;
  const metadata = kind === 'v0.91' ? ARD_V091_SCHEMA : ARD_PREDECESSOR_SCHEMA;
  const valid = validator(document);
  if (!valid) return { validation: validation(false, validator, metadata) };
  const value = document as {
    specVersion?: string;
    entries: ArdEntryValue[];
    host?: unknown;
  };
  const warnings =
    kind === 'v0.91'
      ? value.entries.flatMap((entry) => {
          const count = entry.representativeQueries?.length;
          return count === undefined
            ? ['REPRESENTATIVE_QUERIES_MISSING']
            : count < 2 || count > 5
              ? ['REPRESENTATIVE_QUERIES_COUNT']
              : [];
        })
      : [];
  return {
    validation: validation(true, validator, metadata),
    summary: {
      specVersion:
        kind === 'v0.91' ? 'v0.91' : (value.specVersion ?? 'predecessor'),
      entries: value.entries.length,
      entryTypes: [...new Set(value.entries.map((entry) => entry.type))].sort(),
      hostPresent: value.host !== undefined,
      ardVersion: kind,
      predecessorFallbackUsed: kind === 'predecessor',
      conformanceWarnings: [...new Set(warnings)].sort(),
      mcpServerCardUrls: value.entries
        .filter(
          (entry) =>
            entry.type === 'application/mcp-server-card+json' &&
            typeof entry.url === 'string',
        )
        .map((entry) => entry.url!),
      openApiUrls: value.entries
        .filter(
          (entry) =>
            isOpenApiMediaType(entry.type) && typeof entry.url === 'string',
        )
        .map((entry) => entry.url!),
      openApiInline: value.entries
        .filter((entry) => isOpenApiMediaType(entry.type) && entry.data)
        .map((entry) => ({ identifier: entry.identifier, data: entry.data! })),
      mcpServerCardInline: value.entries
        .filter(
          (entry) =>
            entry.type === 'application/mcp-server-card+json' && entry.data,
        )
        .map((entry) => ({ identifier: entry.identifier, data: entry.data! })),
      declarations: value.entries
        .map(({ identifier, displayName, type, url, data }) => ({
          identifier,
          displayName,
          type,
          url,
          data,
        }))
        .sort((a, b) => a.identifier.localeCompare(b.identifier, 'en')),
    },
  };
}

export const validateArdV091 = (document: unknown) =>
  validateArdWith(document, 'v0.91');
export async function interpretArdV091(
  document: unknown,
  summary: ArdSummary,
): Promise<ArdSummary> {
  const entries = (document as { entries: ArdEntryValue[] }).entries;
  const interpreted = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      semantic: await interpretArdEntry(
        entry as unknown as Record<string, unknown>,
      ),
    })),
  );
  const usable = interpreted
    .filter((item) => item.semantic.coreTermsComplete)
    .map(({ entry, semantic }) => ({
      identifier: String(
        expandedScalar(semantic.expanded, `${ARD_NAMESPACE}identifier`) ??
          entry.identifier,
      ),
      displayName: String(
        expandedScalar(semantic.expanded, `${ARD_NAMESPACE}displayName`) ??
          entry.displayName,
      ),
      type: String(
        expandedScalar(semantic.expanded, `${ARD_NAMESPACE}mediaType`) ?? '',
      ),
      url: expandedScalar(semantic.expanded, `${ARD_NAMESPACE}url`) as
        string | undefined,
      data: expandedScalar(semantic.expanded, `${ARD_NAMESPACE}data`) as
        Record<string, unknown> | undefined,
    }));
  const external = [
    ...new Set(
      interpreted.flatMap((item) => item.semantic.externalContextsNotResolved),
    ),
  ].sort();
  const incomplete = interpreted.some(
    (item) => !item.semantic.coreTermsComplete,
  );
  return {
    ...summary,
    conformanceWarnings: [
      ...new Set([
        ...(summary.conformanceWarnings ?? []),
        ...(external.length ? ['EXTERNAL_CONTEXT_NOT_RESOLVED'] : []),
        ...(incomplete ? ['JSON_LD_CORE_TERMS_INCOMPLETE'] : []),
      ]),
    ].sort(),
    mcpServerCardUrls: usable
      .filter(
        (entry) =>
          entry.type === 'application/mcp-server-card+json' && entry.url,
      )
      .map((entry) => entry.url!)
      .sort(),
    openApiUrls: usable
      .filter((entry) => isOpenApiMediaType(entry.type) && entry.url)
      .map((entry) => entry.url!)
      .sort(),
    openApiInline: usable
      .filter((entry) => isOpenApiMediaType(entry.type) && entry.data)
      .map((entry) => ({ identifier: entry.identifier, data: entry.data! }))
      .sort((a, b) => a.identifier.localeCompare(b.identifier, 'en')),
    mcpServerCardInline: usable
      .filter(
        (entry) =>
          entry.type === 'application/mcp-server-card+json' && entry.data,
      )
      .map((entry) => ({ identifier: entry.identifier, data: entry.data! }))
      .sort((a, b) => a.identifier.localeCompare(b.identifier, 'en')),
    declarations: usable
      .map(({ identifier, displayName, type, url, data }) => ({
        identifier,
        displayName,
        type,
        url,
        data,
      }))
      .sort((a, b) => a.identifier.localeCompare(b.identifier, 'en')),
    jsonLd: {
      baseContextApplied: true,
      coreTermIris: [
        ...new Set(interpreted.flatMap((item) => item.semantic.coreTermIris)),
      ].sort(),
      extensionTermIris: [
        ...new Set(
          interpreted.flatMap((item) => item.semantic.extensionTermIris),
        ),
      ].sort(),
      externalContextsNotResolved: external,
      coreTermsComplete: !incomplete,
    },
  };
}

export const validateArdPredecessor = (document: unknown) =>
  validateArdWith(document, 'predecessor');
/** Backward-compatible validator export for predecessor fixtures. */
export const validateArd = validateArdPredecessor;

export function validateA2a(document: unknown): {
  validation: DiscoveryValidation;
  summary?: A2aSummary;
} {
  const valid = a2aValidator(document);
  if (!valid)
    return { validation: validation(false, a2aValidator, A2A_SCHEMA) };
  const value = document as {
    name?: string;
    version?: string;
    description?: string;
    skills?: {
      id?: string;
      name?: string;
      description?: string;
      tags?: string[];
      examples?: string[];
      inputModes?: string[];
      outputModes?: string[];
    }[];
    supportedInterfaces?: {
      url?: string;
      protocolBinding?: string;
      protocolVersion?: string;
    }[];
    securitySchemes?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    signatures?: unknown[];
  };
  return {
    validation: validation(true, a2aValidator, A2A_SCHEMA),
    summary: {
      name: value.name ?? '',
      agentVersion: value.version ?? '',
      description: value.description,
      skills: (value.skills ?? []).map((skill) => ({
        id: skill.id ?? '',
        name: skill.name ?? '',
        description: skill.description,
        tags: [...(skill.tags ?? [])].sort(),
        examples: [...(skill.examples ?? [])].sort(),
        inputModes: [...(skill.inputModes ?? [])].sort(),
        outputModes: [...(skill.outputModes ?? [])].sort(),
      })),
      interfaces: (value.supportedInterfaces ?? [])
        .map((item) => ({
          url: item.url ?? '',
          protocolBinding: item.protocolBinding ?? '',
          protocolVersion: item.protocolVersion ?? '',
        }))
        .sort((a, b) =>
          `${a.url}\0${a.protocolBinding}`.localeCompare(
            `${b.url}\0${b.protocolBinding}`,
            'en',
          ),
        ),
      interfaceCount: value.supportedInterfaces?.length ?? 0,
      securitySchemes: Object.keys(value.securitySchemes ?? {}).sort(),
      capabilities: Object.entries(value.capabilities ?? {})
        .filter(
          ([, enabled]) =>
            enabled === true || (Array.isArray(enabled) && enabled.length > 0),
        )
        .map(([name]) => name)
        .sort(),
      signaturePresent: (value.signatures?.length ?? 0) > 0,
    },
  };
}

export function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}
