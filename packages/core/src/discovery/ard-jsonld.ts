import jsonld from 'jsonld';
import ardContextDocument from './schemas/ard-v091.context.json';

export const ARD_BASE_CONTEXT_URL =
  'https://agenticresourcediscovery.org/context/v1' as const;
export const ARD_NAMESPACE =
  'https://agenticresourcediscovery.org/ns#' as const;
export const ARD_CORE_TERM_IRIS = [
  'identifier',
  'displayName',
  'mediaType',
  'url',
  'data',
  'representativeQueries',
  'capabilities',
  'description',
  'tags',
  'version',
  'updatedAt',
  'metadata',
  'trustManifest',
].map((term) => `${ARD_NAMESPACE}${term}`);

type Entry = Record<string, unknown>;
export type ArdJsonLdInterpretation = {
  baseContextApplied: true;
  coreTermIris: string[];
  extensionTermIris: string[];
  externalContextsNotResolved: string[];
  coreTermsComplete: boolean;
  expanded: Record<string, unknown>;
};
function contextPolicy(value: unknown, external: Set<string>): unknown {
  if (typeof value === 'string') {
    if (value === ARD_BASE_CONTEXT_URL) return value;
    external.add(value);
    return undefined;
  }
  if (Array.isArray(value))
    return value
      .map((item) => contextPolicy(item, external))
      .filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key === '@import' && typeof item === 'string') {
        external.add(item);
        continue;
      }
      result[key] = item;
    }
    return result;
  }
  return value;
}
const loader = async (url: string) => {
  if (url !== ARD_BASE_CONTEXT_URL) throw new Error('REMOTE_CONTEXT_DISABLED');
  return { contextUrl: null, documentUrl: url, document: ardContextDocument };
};
export async function interpretArdEntry(
  entry: Entry,
): Promise<ArdJsonLdInterpretation> {
  const external = new Set<string>();
  const sanitized = { ...entry };
  if ('@context' in sanitized) {
    const context = contextPolicy(sanitized['@context'], external);
    if (
      context === undefined ||
      (Array.isArray(context) && context.length === 0)
    )
      delete sanitized['@context'];
    else sanitized['@context'] = context;
  }
  let expanded: Record<string, unknown> = {};
  try {
    const values = await jsonld.expand(sanitized as never, {
      expandContext: ardContextDocument['@context'] as never,
      documentLoader: loader as never,
    });
    expanded = (values[0] ?? {}) as Record<string, unknown>;
  } catch {
    external.add('inline-context-processing-failed');
    const fallback = { ...sanitized };
    delete fallback['@context'];
    const values = await jsonld.expand(fallback as never, {
      expandContext: ardContextDocument['@context'] as never,
      documentLoader: loader as never,
    });
    expanded = (values[0] ?? {}) as Record<string, unknown>;
  }
  const keys = Object.keys(expanded).sort();
  const core = keys.filter((key) => ARD_CORE_TERM_IRIS.includes(key));
  const extensions = keys.filter(
    (key) => !key.startsWith('@') && !ARD_CORE_TERM_IRIS.includes(key),
  );
  const required = ['identifier', 'displayName', 'mediaType'].map(
    (term) => `${ARD_NAMESPACE}${term}`,
  );
  const delivery = [`${ARD_NAMESPACE}url`, `${ARD_NAMESPACE}data`];
  return {
    baseContextApplied: true,
    coreTermIris: core,
    extensionTermIris: extensions,
    externalContextsNotResolved: [...external].sort(),
    coreTermsComplete:
      required.every((key) => key in expanded) &&
      delivery.filter((key) => key in expanded).length === 1,
    expanded,
  };
}
export function expandedScalar(
  expanded: Record<string, unknown>,
  iri: string,
): unknown {
  const first = (expanded[iri] as Record<string, unknown>[] | undefined)?.[0];
  return first?.['@id'] ?? first?.['@value'];
}
