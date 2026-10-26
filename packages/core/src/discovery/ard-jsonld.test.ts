import { describe, expect, it } from 'vitest';
import { ARD_NAMESPACE, interpretArdEntry } from './ard-jsonld';
const core = {
  identifier: 'urn:air:example.com:mcp:one',
  displayName: 'One',
  type: 'application/mcp-server-card+json',
  url: 'https://example.com/card',
  representativeQueries: ['one', 'two'],
  capabilities: ['read'],
  description: 'Description',
  tags: ['tag'],
  version: '1',
  metadata: { key: 'value' },
  trustManifest: { identity: 'https://example.com' },
};
describe('ARD v0.91 JSON-LD interpretation', () => {
  it('applies the pinned base context when @context is absent', async () => {
    const value = await interpretArdEntry(core);
    expect(value.baseContextApplied).toBe(true);
    for (const term of [
      'identifier',
      'displayName',
      'mediaType',
      'url',
      'representativeQueries',
      'capabilities',
      'description',
      'tags',
      'version',
      'metadata',
      'trustManifest',
    ])
      expect(value.coreTermIris).toContain(`${ARD_NAMESPACE}${term}`);
    expect(value.coreTermsComplete).toBe(true);
    const inline = await interpretArdEntry({
      ...core,
      url: undefined,
      data: { endpoint: 'https://example.com/mcp' },
    });
    expect(inline.coreTermIris).toContain(`${ARD_NAMESPACE}data`);
  });
  it('expands equivalent inline namespace prefixes to the same IRI', async () => {
    const one = await interpretArdEntry({
      ...core,
      '@context': { one: 'https://extensions.example/ns#' },
      'one:tier': 'public',
    });
    const two = await interpretArdEntry({
      ...core,
      '@context': { two: 'https://extensions.example/ns#' },
      'two:tier': 'public',
    });
    expect(one.extensionTermIris).toContain(
      'https://extensions.example/ns#tier',
    );
    expect(two.extensionTermIris).toEqual(one.extensionTermIris);
  });
  it('never loads an arbitrary remote custom context and reports the limitation', async () => {
    const value = await interpretArdEntry({
      ...core,
      '@context': 'https://context-sentinel.invalid/vocab',
    });
    expect(value.coreTermsComplete).toBe(true);
    expect(value.externalContextsNotResolved).toEqual([
      'https://context-sentinel.invalid/vocab',
    ]);
    expect(JSON.stringify(value)).not.toContain('fetched');
  });
});
