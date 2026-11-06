import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  AP2_EXTENSION_URI,
  type A2aExtension,
  type DiscoveryValidation,
  type UcpSummary,
} from '@interfacedelta/contracts';
import bundle from './schemas/ucp-profile.bundle.json';

export const AP2_SPEC_REVISION = 'e1ea56db72a6385bce3e5c1112b3a56ce60acb43';

// Vendored dependency closure only. No schema, endpoint or supported_versions
// URL from the publisher is ever retrieved.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const schema of bundle.schemas) ajv.addSchema(schema);
const validator = ajv.compile({
  $ref: 'https://ucp.dev/schemas/profile.json#/$defs/business_schema',
});
export const UCP_SCHEMA = {
  name: 'UCP Business Profile',
  version: '2026-08-25',
  revision: bundle.revision,
  file: `${bundle.source}/profile.json#/$defs/business_schema`,
  sha256: createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
};

export function validateUcp(document: unknown): {
  validation: DiscoveryValidation;
  summary?: UcpSummary;
} {
  const valid = validator(document);
  const validation: DiscoveryValidation = {
    valid,
    schemaName: UCP_SCHEMA.name,
    schemaVersion: UCP_SCHEMA.version,
    schemaRevision: UCP_SCHEMA.revision,
    schemaFile: UCP_SCHEMA.file,
    schemaSha256: UCP_SCHEMA.sha256,
    errors: (validator.errors ?? []).map((error) => ({
      code: error.keyword,
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      message: error.message ?? 'Invalid UCP profile.',
      params: error.params,
    })),
  };
  if (!valid) return { validation };
  type Entity = Omit<UcpSummary['services'][number], 'name'>;
  const value = (
    document as {
      ucp: {
        version: string;
        services: Record<string, Entity[]>;
        capabilities?: Record<string, Entity[]>;
        payment_handlers: Record<string, Entity[]>;
      };
    }
  ).ucp;
  const entities = (registry: Record<string, Entity[]> = {}) =>
    Object.entries(registry)
      .flatMap(([name, items]) =>
        items.map((item) => ({
          name,
          version: item.version,
          ...(item.id === undefined ? {} : { id: item.id }),
          ...(item.spec === undefined ? {} : { spec: item.spec }),
          ...(item.schema === undefined ? {} : { schema: item.schema }),
          ...(item.transport === undefined
            ? {}
            : { transport: item.transport }),
          ...(item.endpoint === undefined ? {} : { endpoint: item.endpoint }),
        })),
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  return {
    validation,
    summary: {
      version: value.version,
      services: entities(value.services),
      capabilities: entities(value.capabilities),
      paymentHandlers: entities(value.payment_handlers),
    },
  };
}

export function parseA2aExtensions(input: unknown): A2aExtension[] {
  if (!Array.isArray(input)) return [];
  const extensions = input.flatMap((item: unknown): A2aExtension[] => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    if (typeof value.uri !== 'string') return [];
    const params = value.params as { roles?: unknown } | undefined;
    return [
      {
        uri: value.uri,
        required: value.required === true,
        ...(value.uri === AP2_EXTENSION_URI
          ? {
              roles: [
                ...new Set(
                  Array.isArray(params?.roles)
                    ? params.roles.filter(
                        (role): role is string => typeof role === 'string',
                      )
                    : [],
                ),
              ].sort(),
            }
          : {}),
      },
    ];
  });
  return [
    ...new Map(extensions.map((item) => [JSON.stringify(item), item])).values(),
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}
