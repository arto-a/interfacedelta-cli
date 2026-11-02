import { describe, expect, it } from 'vitest';
import type { Decision } from './guard';
import {
  ALLOWLIST_FORMAT_VERSION,
  DEFAULT_POLICY_SOURCE,
  toGenericAllowlist,
  toGitHubAllowlist,
  type PolicyExportEntry,
} from './policy-export';
import type { CheckResult, DependencyOutcome, ErrorKind } from './types';

/** Only the fields the export reads, like the fixtures in format.test.ts. */
function checkResult(
  policyResult: 'passed' | 'failed',
  decisions: Array<Pick<Decision, 'action' | 'source'>> = [],
): CheckResult {
  return {
    decisions: decisions as Decision[],
    policy: {
      version: 'ci-policy-v2',
      rulesVersion: 'decision-rules-v1',
      failOn: ['breaking'],
      result: policyResult,
    },
  } as unknown as CheckResult;
}

const dep = (name: string, over: Partial<PolicyExportEntry> = {}) => ({
  name,
  url: `https://${name}.example.com`,
  mcpEndpoint: null,
  ...over,
});

const outcome = (
  spec:
    | {
        status: 'checked';
        policyResult?: 'passed' | 'failed';
        decisions?: Array<Pick<Decision, 'action' | 'source'>>;
      }
    | { status: 'error'; kind: ErrorKind },
): DependencyOutcome => {
  if (spec.status === 'error')
    return {
      status: 'error',
      error: { kind: spec.kind, message: 'inspection failed' },
    } as DependencyOutcome;
  return {
    status: 'checked',
    result: checkResult(spec.policyResult ?? 'passed', spec.decisions),
  } as DependencyOutcome;
};

const passing = (name: string, over: Partial<PolicyExportEntry> = {}) => ({
  ...dep(name, over),
  outcome: over.outcome ?? outcome({ status: 'checked' }),
});

describe('toGenericAllowlist', () => {
  it('defaults to passing dependencies only', () => {
    const export_ = toGenericAllowlist([
      dep('http-only', { url: 'http://insecure.example.com' }),
      passing('search'),
      dep('unreviewed'),
    ]);
    expect(export_.format).toBe(ALLOWLIST_FORMAT_VERSION);
    expect(export_.generatedFrom).toBe(DEFAULT_POLICY_SOURCE);
    expect(export_.servers).toEqual([
      {
        name: 'search',
        protocol: 'unknown',
        url: 'https://search.example.com',
        decision: 'allow',
        reasons: ['check-passed'],
      },
    ]);
    expect(export_.excluded).toEqual(
      expect.arrayContaining([
        {
          name: 'unreviewed',
          url: 'https://unreviewed.example.com',
          decision: 'review',
          reasons: ['not-checked'],
        },

        {
          name: 'http-only',
          url: 'http://insecure.example.com',
          decision: 'review',
          reasons: ['url-not-https'],
        },
      ]),
    );
  });

  it('include: passing moves breaking and review dependencies to excluded', () => {
    const entries = [
      passing('fine'),
      dep('breaking', {
        outcome: outcome({ status: 'checked', policyResult: 'failed' }),
      }),
      dep('warned', {
        outcome: outcome({
          status: 'checked',
          decisions: [{ action: 'warn', source: 'policy' }],
        }),
      }),
      dep('errored', {
        outcome: outcome({ status: 'error', kind: 'inspection' }),
      }),
    ];
    const export_ = toGenericAllowlist(entries, { include: 'passing' });
    expect(export_.servers).toEqual([
      {
        name: 'fine',
        protocol: 'unknown',
        url: 'https://fine.example.com',
        decision: 'allow',
        reasons: ['check-passed'],
      },
    ]);
    expect(export_.excluded.map((excluded) => excluded.reasons)).toEqual([
      ['breaking-change'],
      ['check-error-inspection'],
      ['changes-need-review'],
    ]);
  });

  it('records accepted changes on a passing dependency', () => {
    const export_ = toGenericAllowlist([
      passing('accepted', {
        outcome: outcome({
          status: 'checked',
          decisions: [{ action: 'allow', source: 'acceptance' }],
        }),
      }),
    ]);
    expect(export_.servers[0]!.reasons).toEqual([
      'check-passed',
      'changes-accepted',
    ]);
  });

  it('uses the MCP endpoint as the allowlisted URL and defaults to mcp', () => {
    const export_ = toGenericAllowlist([
      passing('gateway', {
        url: 'https://gateway.example.com',
        mcpEndpoint: 'https://gateway.example.com/mcp',
      }),
    ]);
    expect(export_.servers[0]).toMatchObject({
      protocol: 'mcp',
      url: 'https://gateway.example.com/mcp',
      decision: 'allow',
    });
  });

  it('honors an explicit protocol', () => {
    const export_ = toGenericAllowlist([
      passing('api', { protocol: 'openapi' }),
    ]);
    expect(export_.servers[0]!.protocol).toBe('openapi');
  });

  it('excludes non-https endpoints even when the inspected URL is https', () => {
    const export_ = toGenericAllowlist([
      dep('mixed', {
        url: 'https://mixed.example.com',
        mcpEndpoint: 'http://mixed.example.com/mcp',
      }),
      dep('nonsense', { url: 'not a url' }),
    ]);
    expect(export_.servers).toEqual([]);
    expect(export_.excluded).toEqual([
      {
        name: 'mixed',
        url: 'http://mixed.example.com/mcp',
        decision: 'review',
        reasons: ['url-not-https'],
      },
      {
        name: 'nonsense',
        url: 'not a url',
        decision: 'review',
        reasons: ['url-invalid'],
      },
    ]);
  });

  it('sorts servers and exclusions by name, then URL', () => {
    const export_ = toGenericAllowlist([
      passing('zeta'),
      passing('alpha', { url: 'https://b.example.com' }),
      passing('alpha', { url: 'https://a.example.com' }),
      dep('m', { url: 'http://m.example.com' }),
      dep('m', { url: 'http://a.example.com' }),
    ]);
    expect(export_.servers.map((server) => [server.name, server.url])).toEqual([
      ['alpha', 'https://a.example.com'],
      ['alpha', 'https://b.example.com'],
      ['zeta', 'https://zeta.example.com'],
    ]);
    expect(export_.excluded.map((excluded) => excluded.url)).toEqual([
      'http://a.example.com',
      'http://m.example.com',
    ]);
  });

  it('records generatedFrom', () => {
    const export_ = toGenericAllowlist([], {
      generatedFrom: 'team/dependencies.json',
    });
    expect(export_.generatedFrom).toBe('team/dependencies.json');
  });

  it('exports an empty document for empty input', () => {
    expect(toGenericAllowlist([])).toEqual({
      format: ALLOWLIST_FORMAT_VERSION,
      generatedFrom: DEFAULT_POLICY_SOURCE,
      servers: [],
      excluded: [],
    });
  });

  it('is stable for the same input', () => {
    const entries = [
      dep('unreviewed'),
      passing('zeta'),
      dep('http-only', { url: 'http://x.example.com' }),
    ];
    expect(JSON.stringify(toGenericAllowlist(entries))).toBe(
      JSON.stringify(toGenericAllowlist([...entries].reverse())),
    );
  });
});

const mcpPassing = (name: string, over: Partial<PolicyExportEntry> = {}) =>
  passing(name, { protocol: 'mcp', ...over });

describe('toGitHubAllowlist', () => {
  it('emits the documented allowedMcpServers shape with exact server URLs', () => {
    const export_ = toGitHubAllowlist([
      mcpPassing('copilot', { url: 'https://api.githubcopilot.com/mcp' }),
    ]);
    expect(export_.managedSettings).toEqual({
      allowedMcpServers: [{ serverUrl: 'https://api.githubcopilot.com/mcp' }],
    });
    for (const matcher of export_.managedSettings.allowedMcpServers)
      expect(Object.keys(matcher)).toEqual(['serverUrl']);
  });

  it('only allows dependencies whose latest check passed', () => {
    const export_ = toGitHubAllowlist([
      mcpPassing('fine'),
      dep('breaking', {
        outcome: outcome({ status: 'checked', policyResult: 'failed' }),
      }),
      dep('unreviewed'),
      dep('legacy', { url: 'http://legacy.example.com' }),
    ]);
    expect(export_.managedSettings.allowedMcpServers).toEqual([
      { serverUrl: 'https://fine.example.com' },
    ]);
    expect(export_.excluded).toEqual([
      {
        name: 'breaking',
        url: 'https://breaking.example.com',
        decision: 'review',
        reasons: ['breaking-change'],
      },
      {
        name: 'legacy',
        url: 'http://legacy.example.com',
        decision: 'review',
        reasons: ['url-not-https'],
      },
      {
        name: 'unreviewed',
        url: 'https://unreviewed.example.com',
        decision: 'review',
        reasons: ['not-checked'],
      },
    ]);
  });

  it('deduplicates identical server URLs', () => {
    const export_ = toGitHubAllowlist([
      mcpPassing('one', { mcpEndpoint: 'https://shared.example.com/mcp' }),
      mcpPassing('two', { mcpEndpoint: 'https://shared.example.com/mcp' }),
    ]);
    expect(export_.managedSettings.allowedMcpServers).toEqual([
      { serverUrl: 'https://shared.example.com/mcp' },
    ]);
    expect(export_.excluded).toEqual([]);
  });

  it('sorts matchers by URL and carries generatedFrom', () => {
    const export_ = toGitHubAllowlist(
      [mcpPassing('zeta'), mcpPassing('alpha')],
      {
        generatedFrom: 'team/dependencies.json',
      },
    );
    expect(
      export_.managedSettings.allowedMcpServers.map((m) => m.serverUrl),
    ).toEqual(['https://alpha.example.com', 'https://zeta.example.com']);
    expect(export_.generatedFrom).toBe('team/dependencies.json');
  });

  it('does not change with include: passing', () => {
    const entries = [
      mcpPassing('fine'),
      dep('breaking', {
        outcome: outcome({ status: 'checked', policyResult: 'failed' }),
      }),
    ];
    expect(toGitHubAllowlist(entries, { include: 'passing' })).toEqual(
      toGitHubAllowlist(entries),
    );
  });

  it('fails closed with an empty allowlist for empty input', () => {
    const export_ = toGitHubAllowlist([]);
    expect(export_.managedSettings).toEqual({ allowedMcpServers: [] });
    expect(export_.excluded).toEqual([]);
  });

  it('is stable for the same input', () => {
    const entries = [
      mcpPassing('zeta'),
      dep('unreviewed'),
      dep('http-only', { url: 'http://x.example.com' }),
    ];
    expect(JSON.stringify(toGitHubAllowlist(entries))).toBe(
      JSON.stringify(toGitHubAllowlist([...entries].reverse())),
    );
  });
});

describe('GitHub matcher boundaries', () => {
  it('excludes wildcards and dependencies without an explicit MCP protocol', () => {
    const result = toGitHubAllowlist([
      passing('web'),
      mcpPassing('wild', { mcpEndpoint: 'https://example.com/*' }),
    ]);
    expect(result.managedSettings.allowedMcpServers).toEqual([]);
    expect(result.excluded.map((item) => item.reasons[0])).toEqual([
      'not-explicit-mcp',
      'url-wildcard',
    ]);
  });
});

it.each(['failed', 'unchecked'] as const)(
  'excludes a URL if another entry is %s',
  (state) => {
    const url = 'https://shared.example/mcp';
    const entries = [
      passing('good', { mcpEndpoint: url }),
      dep('bad', {
        mcpEndpoint: url,
        ...(state === 'failed'
          ? { outcome: outcome({ status: 'checked', policyResult: 'failed' }) }
          : {}),
      }),
    ];
    expect(toGenericAllowlist(entries).servers).toEqual([]);
    expect(
      toGitHubAllowlist(entries).managedSettings.allowedMcpServers,
    ).toEqual([]);
  },
);
