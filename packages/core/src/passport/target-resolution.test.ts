import { describe, expect, it } from 'vitest';
import {
  resolveMonitoredTarget as resolveTarget,
  resolveTarget as resolveLocalTarget,
} from './target-resolution';
import { createTargetScope, targetKey } from './target-scope';

describe('hosted direct document resolution', () => {
  it('keeps local CLI document scopes and scan URLs unchanged', () => {
    const url = 'https://gist.githubusercontent.com/user/123/raw/openapi.json';
    expect(resolveLocalTarget(url)).toEqual({
      targetScope: createTargetScope(url),
      inspectionUrl: url,
      monitoredPage: null,
    });
  });
  it.each([
    ['/team-a/openapi.json', 'openapi'],
    ['/team-a/swagger-v2.yaml', 'openapi'],
    ['/team-a/.well-known/agent-card.json', 'a2a'],
    ['/team-a/.well-known/ard.json', 'ard'],
    ['/team-a/.well-known/ai-catalog.json', 'ard'],
  ])('pins %s as %s', (path, type) => {
    const target = resolveTarget(`https://SHARED.example.com.${path}`);
    expect(target).toEqual({
      inspectionUrl: `https://shared.example.com${path}`,
      monitoredPage: null,
      targetScope: {
        scopeVersion: 'target-scope-v3',
        origin: 'https://shared.example.com',
        explicitMcpEndpoint: null,
        monitoredDocument: { path, type },
      },
    });
  });

  it('does not collapse documents on a shared gist host', () => {
    const urls = ['alice/123', 'bob/456'].map(
      (id) => `https://gist.githubusercontent.com/${id}/raw/openapi.json`,
    );
    expect(
      new Set(urls.map((url) => targetKey(resolveTarget(url).targetScope))),
    ).toHaveLength(2);
  });

  it('keeps non-document v1 and v2 scopes unchanged', () => {
    expect(resolveTarget('https://example.com/mcp').targetScope).toEqual(
      createTargetScope('https://example.com'),
    );
    expect(resolveTarget('https://example.com/team-a').targetScope).toEqual({
      scopeVersion: 'target-scope-v2',
      origin: 'https://example.com',
      explicitMcpEndpoint: null,
      monitoredPage: '/team-a',
    });
  });

  it.each([
    'http://example.com/openapi.json',
    'https://127.0.0.1/openapi.json',
    'https://localhost/openapi.json',
    'https://private.internal/openapi.json',
    'https://user:pass@example.com/openapi.json',
    'https://example.com:8443/openapi.json',
    'https://example.com//evil.com/openapi.json',
    'https://example.com/token=secret/openapi.json',
    'https://example.com/openapi.json?token=secret',
    'https://example.com/openapi.json#fragment',
  ])('rejects unsafe target %s', (url) => {
    expect(() => resolveTarget(url)).toThrow();
  });
});
