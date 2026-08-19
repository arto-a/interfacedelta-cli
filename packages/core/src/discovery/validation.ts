import { createHash } from 'node:crypto';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { A2aSummary, ArdSummary, DiscoveryValidation, ValidationIssue } from '@interfacedelta/contracts';
import ardSchema from './schemas/ard-ai-catalog.schema.json';
import a2aBundle from './schemas/a2a-v1.schema.json';

export const ARD_SCHEMA = {
  name: 'Agentic Resource Discovery AI Catalog', version: '0.9 draft', revision: '5fa2f5aef790b478319f6a3b43adf4661b0ed0e0',
  file: 'spec/schemas/ai-catalog.schema.json', sha256: 'c55238483a4738e08b250bdd6af1f4dc05a91afe882c649d224d09c19cd8fe09',
} as const;
export const A2A_SCHEMA = {
  name: 'A2A Agent Card', version: '1.0', revision: '173695755607e884aa9acf8ce4feed90e32727a1',
  file: 'official generated specification/json/a2a.json bundle', sha256: '8e16bb6822202d211fbcc0f36cd6d75420780f35975272bd5ed142a5ccf51123',
} as const;

function issues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({ code: error.keyword, instancePath: error.instancePath, schemaPath: error.schemaPath, message: error.message ?? 'Validation failed.', params: error.params as Record<string, unknown> }));
}

function createAjv(): Ajv2020 { const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv); return ajv; }
const ardValidator = createAjv().compile(ardSchema);

type JsonSchema = Record<string, unknown> & { title?: string };
const a2aAjv = createAjv();
const a2aDefinitions = (a2aBundle as { definitions: Record<string, JsonSchema> }).definitions;
for (const schema of Object.values(a2aDefinitions)) {
  if (schema.title) {
    const namespace = ['Struct', 'Timestamp', 'Value'].includes(schema.title) ? 'google.protobuf' : 'lf.a2a.v1';
    a2aAjv.addSchema(schema, `${namespace}.${schema.title.replaceAll(' ', '')}.jsonschema.json`);
  }
}
const a2aValidator: ValidateFunction = a2aAjv.getSchema('lf.a2a.v1.AgentCard.jsonschema.json')!;

function validation(valid: boolean, validator: ValidateFunction, metadata: typeof ARD_SCHEMA | typeof A2A_SCHEMA): DiscoveryValidation {
  return { valid, schemaName: metadata.name, schemaVersion: metadata.version, schemaRevision: metadata.revision, schemaFile: metadata.file, schemaSha256: metadata.sha256, errors: issues(validator.errors) };
}

export function validateArd(document: unknown): { validation: DiscoveryValidation; summary?: ArdSummary } {
  const valid = ardValidator(document);
  if (!valid) return { validation: validation(false, ardValidator, ARD_SCHEMA) };
  const value = document as { specVersion: string; entries: { identifier:string;displayName:string;type: string; url?: string }[]; host?: unknown };
  return { validation: validation(true, ardValidator, ARD_SCHEMA), summary: {
    specVersion: value.specVersion, entries: value.entries.length,
    entryTypes: [...new Set(value.entries.map((entry) => entry.type))].sort(), hostPresent: value.host !== undefined,
    mcpServerCardUrls: value.entries.filter((entry) => entry.type === 'application/mcp-server-card+json' && typeof entry.url === 'string').map((entry) => entry.url!),
    declarations:value.entries.map(({identifier,displayName,type,url})=>({identifier,displayName,type,url})).sort((a,b)=>a.identifier.localeCompare(b.identifier)),
  } };
}

export function validateA2a(document: unknown): { validation: DiscoveryValidation; summary?: A2aSummary } {
  const valid = a2aValidator(document);
  if (!valid) return { validation: validation(false, a2aValidator, A2A_SCHEMA) };
  const value = document as { name?: string; version?: string;description?:string; skills?: {id?: string; name?: string;description?:string;tags?:string[];examples?:string[];inputModes?:string[];outputModes?:string[]}[]; supportedInterfaces?: {url?:string;protocolBinding?:string;protocolVersion?:string}[]; securitySchemes?: Record<string, unknown>; capabilities?: Record<string, unknown>; signatures?: unknown[] };
  return { validation: validation(true, a2aValidator, A2A_SCHEMA), summary: {
    name: value.name ?? '', agentVersion: value.version ?? '',description:value.description, skills: (value.skills ?? []).map((skill) => ({ id: skill.id ?? '', name: skill.name ?? '',description:skill.description,tags:[...(skill.tags??[])].sort(),examples:[...(skill.examples??[])].sort(),inputModes:[...(skill.inputModes??[])].sort(),outputModes:[...(skill.outputModes??[])].sort() })),
    interfaces:(value.supportedInterfaces??[]).map(item=>({url:item.url??'',protocolBinding:item.protocolBinding??'',protocolVersion:item.protocolVersion??''})).sort((a,b)=>`${a.url}\0${a.protocolBinding}`.localeCompare(`${b.url}\0${b.protocolBinding}`)),
    interfaceCount: value.supportedInterfaces?.length ?? 0, securitySchemes: Object.keys(value.securitySchemes ?? {}).sort(),
    capabilities: Object.entries(value.capabilities ?? {}).filter(([, enabled]) => enabled === true || (Array.isArray(enabled) && enabled.length > 0)).map(([name]) => name).sort(),
    signaturePresent: (value.signatures?.length ?? 0) > 0,
  } };
}

export function sha256(body: Uint8Array): string { return createHash('sha256').update(body).digest('hex'); }
