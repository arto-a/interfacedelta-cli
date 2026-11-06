import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AcpSummary, DiscoveryValidation } from '@interfacedelta/contracts';
import schema from './schemas/acp-discovery.json';

export const ACP_REVISION = '7fdd78df677a94dce04c770644b0fbbb1401272b';
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validator = ajv.compile(schema);
const knownServices = new Set(
  schema.$defs.DiscoveryCapabilities.properties.services.items.enum,
);
const sorted = (values: string[] = []) => [...new Set(values)].sort();
const originOnly = (uri: string) => {
  try {
    return new URL(uri).origin;
  } catch {
    return 'null';
  }
};

export function validateAcp(
  document: unknown,
  headers: Readonly<Record<string, string | undefined>> = {},
): {
  validation: DiscoveryValidation;
  summary?: AcpSummary;
} {
  // Validate the unmodified pinned schema against a copy with unknown string
  // services separated out. All other schema constraints remain enforced.
  const candidate = structuredClone(document);
  const value = candidate as {
    protocol?: { name: string; version: string; supported_versions: string[] };
    api_base_url: string;
    transports: string[];
    capabilities?: {
      services?: unknown[];
      extensions?: { name: string; spec?: string }[];
      intervention_types?: string[];
      supported_currencies?: string[];
      supported_locales?: string[];
    };
  } | null;
  let extras: string[] = [];
  if (value && Array.isArray(value.capabilities?.services)) {
    extras = value.capabilities.services.filter(
      (item): item is string =>
        typeof item === 'string' && !knownServices.has(item),
    );
    value.capabilities.services = value.capabilities.services.filter(
      (item) => typeof item !== 'string' || knownServices.has(item),
    );
  }
  const valid = validator(candidate);
  const validation: DiscoveryValidation = {
    valid,
    schemaName: 'ACP DiscoveryResponse',
    schemaVersion: '2026-04-17',
    schemaRevision: ACP_REVISION,
    schemaFile:
      'spec/2026-04-17/json-schema/schema.agentic_checkout.json#/$defs/DiscoveryResponse',
    schemaSha256: createHash('sha256')
      .update(JSON.stringify(schema))
      .digest('hex'),
    errors: (validator.errors ?? []).map((error) => ({
      code: error.keyword,
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      message: error.message ?? 'Invalid ACP discovery.',
      params: error.params,
    })),
  };
  if (!valid || !value?.protocol || !value.capabilities) return { validation };
  // Non-hierarchical or URL-unparseable URIs have no usable origin. They remain schema-valid data,
  // represented by the URL API's "null" origin; never followed.
  const capabilities = value.capabilities;
  const droppedCounts: Record<string, number> = {};
  const bounded = (
    field: string,
    values: string[] = [],
    pattern: RegExp | ((value: string) => boolean),
    limit: number,
  ) => {
    const kept = sorted(
      values.filter((v) =>
        typeof pattern === 'function' ? pattern(v) : pattern.test(v),
      ),
    ).slice(0, limit);
    droppedCounts[field] = values.length - kept.length;
    return kept;
  };
  const namePattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
  const extraServices = bounded('services', extras, namePattern, 32);
  const extensions = (capabilities.extensions ?? [])
    .filter((item) => namePattern.test(item.name))
    .map((item) => {
      let spec: string | undefined;
      if (
        item.spec &&
        item.spec.length <= 512 &&
        // eslint-disable-next-line no-control-regex
        !/[\x00-\x20\x7f]/.test(item.spec)
      ) {
        try {
          const url = new URL(item.spec);
          if (url.protocol === 'https:') spec = url.origin + url.pathname;
        } catch {
          /* Invalid URL: observation only. */
        }
      }
      if (item.spec !== undefined && spec === undefined)
        droppedCounts.spec = (droppedCounts.spec ?? 0) + 1;
      return { name: item.name, ...(spec ? { spec } : {}) };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))
    .slice(0, 32);
  droppedCounts.extensions =
    (capabilities.extensions ?? []).length - extensions.length;
  return {
    validation,
    summary: {
      protocol: {
        version: value.protocol.version,
        supported_versions: sorted(value.protocol.supported_versions).slice(
          0,
          32,
        ),
      },
      api_base_url: originOnly(value.api_base_url),
      transports: sorted(value.transports),
      capabilities: {
        services: sorted(capabilities.services as string[]),
        extensions,
        intervention_types: sorted(
          capabilities.intervention_types?.filter((v) =>
            ['3ds', 'biometric', 'address_verification'].includes(v),
          ),
        ),
        supported_currencies: bounded(
          'currencies',
          capabilities.supported_currencies,
          /^[a-z]{3}$/,
          64,
        ),
        supported_locales: bounded(
          'locales',
          capabilities.supported_locales,
          (tag) => {
            // Check syntax, not runtime locale support; retain the publisher's spelling.
            // Bound even well-formed tags with very long private-use extensions.
            if (tag.length > 255) return false;
            try {
              return Intl.getCanonicalLocales(tag).length === 1;
            } catch {
              return false;
            }
          },
          64,
        ),
      },
      extras: { services: extraServices },
      droppedCounts,
      ...(headers['cache-control'] === undefined
        ? {}
        : { cacheControl: headers['cache-control'] }),
    },
  };
}
