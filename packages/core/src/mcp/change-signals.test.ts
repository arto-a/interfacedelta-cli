import { describe, expect, it, vi } from 'vitest';
import {
  observeDynamicRegistration,
  observeListChanges,
} from './change-signals';
import { ConstrainedHttpsClient } from '../scanner/outbound-boundary';

const endpoint = new URL('https://example.com/mcp');
const challenge =
  'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp"';
function metadata(
  registration: unknown = 'https://accounts.example.com/register/private?token=secret',
) {
  return { issuer: 'https://example.com', registration_endpoint: registration };
}
function fixture(
  as: unknown = metadata(),
  resource: unknown = {
    resource: endpoint.href,
    authorization_servers: ['https://example.com'],
  },
) {
  const get = vi.fn(async (url: URL) => ({
    ok: true as const,
    httpStatus: 200,
    contentType: 'application/json',
    headers: {},
    body: Buffer.from(
      JSON.stringify(get.mock.calls.length === 1 ? resource : as),
    ),
    finalUrl: url.href,
    durationMs: 1,
    redirects: [],
  }));
  return get;
}
describe('passive change and registration declarations', () => {
  it('distinguishes absent/false, true, malformed and unseen capability declarations', () => {
    expect(
      observeListChanges({
        tools: { listChanged: true },
        resources: { listChanged: false },
        prompts: { listChanged: 'true' },
      }),
    ).toMatchObject({ tools: 'yes', resources: 'no', prompts: 'not_observed' });
    expect(observeListChanges({})).toMatchObject({
      tools: 'no',
      resources: 'no',
      prompts: 'no',
    });
    expect(observeListChanges(undefined)).toMatchObject({
      tools: 'not_observed',
    });
  });
  it('reads exactly the advertised resource and issuer metadata, retains no registration URL', async () => {
    const get = fixture();
    const result = await observeDynamicRegistration(endpoint, challenge, get);
    expect(result).toEqual({
      version: 'oauth-dynamic-registration-v1',
      declared: 'yes',
    });
    expect(get.mock.calls.map(([url]) => url.href)).toEqual([
      'https://example.com/.well-known/oauth-protected-resource/mcp',
      'https://example.com/.well-known/oauth-authorization-server',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|accounts/);
  });
  it('reports no only for a complete matching issuer document without the field', async () => {
    expect(
      (
        await observeDynamicRegistration(
          endpoint,
          challenge,
          fixture({ issuer: 'https://example.com' }),
        )
      ).declared,
    ).toBe('no');
  });
  it.each([
    null,
    1,
    '',
    'javascript:alert(1)',
    'http://example.com/register',
    'https://user:password@example.com/register',
    'https://127.0.0.1/register',
  ])('leaves malformed registration %s unknown', async (value) => {
    expect(
      (
        await observeDynamicRegistration(
          endpoint,
          challenge,
          fixture(metadata(value)),
        )
      ).declared,
    ).toBe('not_observed');
  });
  it.each([
    undefined,
    'Bearer',
    'Bearer resource_metadata="https://other.example/meta"',
    'Bearer resource_metadata="https://127.0.0.1/meta"',
    challenge + ', resource_metadata="https://example.com/other"',
  ])('does not guess or cross origins for %s', async (header) => {
    const get = fixture();
    expect(
      (await observeDynamicRegistration(endpoint, header, get)).declared,
    ).toBe('not_observed');
    expect(get).not.toHaveBeenCalled();
  });
  it.each([
    {
      resource: endpoint.href,
      authorization_servers: ['https://other.example'],
    },
    {
      resource: endpoint.href,
      authorization_servers: ['https://example.com', 'https://other.example'],
    },
    {
      resource: 'https://example.com/other',
      authorization_servers: ['https://example.com'],
    },
  ])('stops at uncertain resource metadata', async (resource) => {
    const get = fixture(metadata(), resource);
    expect(
      (await observeDynamicRegistration(endpoint, challenge, get)).declared,
    ).toBe('not_observed');
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('requires matching issuer and valid JSON, and handles refusal', async () => {
    for (const get of [
      fixture({ issuer: 'https://other.example' }),
      vi.fn(async () => {
        throw new Error('ROBOTS_PATH_DENIED');
      }),
      vi.fn(async () => ({
        ok: true as const,
        httpStatus: 200,
        contentType: 'application/json',
        headers: {},
        body: Buffer.from('{'),
        finalUrl:
          'https://example.com/.well-known/oauth-protected-resource/mcp',
        durationMs: 1,
        redirects: [],
      })),
    ]) {
      expect(
        (await observeDynamicRegistration(endpoint, challenge, get)).declared,
      ).toBe('not_observed');
    }
  });
  it('uses the existing DNS and request policy boundary', async () => {
    const transport = vi.fn();
    const client = new ConstrainedHttpsClient(
      async () => [{ address: '127.0.0.1', family: 4 }],
      transport,
    );
    expect(
      (
        await observeDynamicRegistration(endpoint, challenge, (url) =>
          client.get(url, { redirect: 'reject' }),
        )
      ).declared,
    ).toBe('not_observed');
    expect(transport).not.toHaveBeenCalled();
  });
});

it('rejects redirects and incomplete/non-JSON metadata without attempting issuer discovery', async () => {
  for (const patch of [
    { httpStatus: 302 },
    { httpStatus: 404 },
    { truncated: true as const },
    { contentType: 'text/html' },
    { finalUrl: 'https://example.com/redirected' },
  ]) {
    const get = vi.fn(async (url: URL) => ({
      ok: true as const,
      httpStatus: 200,
      headers: {},
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          resource: endpoint.href,
          authorization_servers: ['https://example.com'],
        }),
      ),
      durationMs: 1,
      finalUrl: url.href,
      redirects: [],
      ...patch,
    }));
    expect(
      (await observeDynamicRegistration(endpoint, challenge, get)).declared,
    ).toBe('not_observed');
    expect(get).toHaveBeenCalledTimes(1);
  }
});
