import type { DependencyOutcome } from './types';

export const ALLOWLIST_FORMAT_VERSION = 'interfacedelta-allowlist-v1' as const;

/** Same path as DEFAULT_DEPENDENCIES_PATH, kept local to avoid I/O imports. */
export const DEFAULT_POLICY_SOURCE = '.interfacedelta/dependencies.json';

/** A dependency to export: its dependencies-file fields plus its latest check. */
export type PolicyExportEntry = {
  name: string;
  url: string;
  /** MCP endpoint when the dependency speaks MCP; the URL allowlists use. */
  mcpEndpoint?: string | null;
  /** Wire protocol shown in the generic export; 'mcp' when an endpoint is set. */
  protocol?: string;
  /** Latest outcome from checkDependencies; absent when no check has run. */
  outcome?: DependencyOutcome;
};

export type PolicyExportOptions = {
  /** Defaults to passing. The legacy all spelling never admits a failed or unchecked URL. */
  include?: 'all' | 'passing';
  /** Path recorded as `generatedFrom`; defaults to the default dependencies path. */
  generatedFrom?: string;
};

export type AllowlistServer = {
  name: string;
  protocol: string;
  url: string;
  decision: 'allow' | 'review';
  reasons: string[];
};

export type AllowlistExclusion = {
  decision: 'review';
  name: string;
  url: string;
  reasons: string[];
};

/** InterfaceDelta's own documented allowlist format. */
export type GenericAllowlist = {
  format: typeof ALLOWLIST_FORMAT_VERSION;
  generatedFrom: string;
  servers: AllowlistServer[];
  excluded: AllowlistExclusion[];
};

/** One GitHub matcher; InterfaceDelta only emits the remote `serverUrl`. */
export type GitHubServerMatcher = { serverUrl: string };

export type GitHubAllowlistExport = {
  generatedFrom: string;
  /** Content for `copilot/managed-settings.json`, in GitHub's format. */
  managedSettings: { allowedMcpServers: GitHubServerMatcher[] };
  /** Dependencies left out of the allowlist, with the reasons. */
  excluded: AllowlistExclusion[];
};

type Classified =
  | { kind: 'url'; url: string; reasons: string[] }
  | {
      kind: 'server';
      url: string;
      protocol: string;
      decision: 'allow' | 'review';
      reasons: string[];
    };

const httpsReason = (url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return 'url-credentials';
    return parsed.protocol === 'https:' ? null : 'url-not-https';
  } catch {
    return 'url-invalid';
  }
};

const protocolFor = (entry: PolicyExportEntry) =>
  entry.protocol ?? (entry.mcpEndpoint ? 'mcp' : 'unknown');

const classify = (entry: PolicyExportEntry): Classified => {
  const serverUrl = entry.mcpEndpoint || entry.url;
  const candidates = entry.mcpEndpoint
    ? [entry.mcpEndpoint, entry.url]
    : [entry.url];
  for (const candidate of candidates) {
    const reason = httpsReason(candidate);
    if (reason) return { kind: 'url', url: candidate, reasons: [reason] };
  }
  const protocol = protocolFor(entry);
  const outcome = entry.outcome;
  if (!outcome)
    return {
      kind: 'server',
      url: serverUrl,
      protocol,
      decision: 'review',
      reasons: ['not-checked'],
    };
  if (outcome.status === 'error')
    return {
      kind: 'server',
      url: serverUrl,
      protocol,
      decision: 'review',
      reasons: [`check-error-${outcome.error.kind}`],
    };
  const reasons: string[] = [];
  if (outcome.result.policy.result === 'failed')
    reasons.push('breaking-change');
  if (outcome.result.decisions.some((decision) => decision.action === 'warn'))
    reasons.push('changes-need-review');
  if (reasons.length === 0) {
    reasons.push('check-passed');
    if (
      outcome.result.decisions.some(
        (decision) => decision.source === 'acceptance',
      )
    )
      reasons.push('changes-accepted');
  }
  return {
    kind: 'server',
    url: serverUrl,
    protocol,
    decision: reasons.includes('check-passed') ? 'allow' : 'review',
    reasons,
  };
};

const byNameThenUrl = (
  a: { name: string; url: string },
  b: { name: string; url: string },
) => a.name.localeCompare(b.name, 'en') || a.url.localeCompare(b.url, 'en');

/**
 * The team's dependency list as an InterfaceDelta allowlist document. Servers
 * are sorted by name, then URL, so the same input always serializes the same.
 */
export function toGenericAllowlist(
  entries: readonly PolicyExportEntry[],
  options: PolicyExportOptions = {},
): GenericAllowlist {
  const servers: AllowlistServer[] = [];
  const excluded: AllowlistExclusion[] = [];
  const blocked = new Set(
    entries
      .map(classify)
      .filter((item) => item.kind === 'url' || item.decision !== 'allow')
      .map((item) => item.url),
  );
  for (const entry of entries) {
    const classified = classify(entry);
    if (classified.kind === 'url') {
      excluded.push({
        decision: 'review',
        name: entry.name,
        url: classified.url,
        reasons: classified.reasons,
      });
    } else if (
      classified.decision === 'allow' &&
      !blocked.has(classified.url)
    ) {
      servers.push({
        name: entry.name,
        protocol: classified.protocol,
        url: classified.url,
        decision: classified.decision,
        reasons: classified.reasons,
      });
    } else {
      excluded.push({
        decision: 'review',
        name: entry.name,
        url: classified.url,
        reasons:
          classified.decision === 'allow'
            ? ['shared-url-not-passing']
            : classified.reasons,
      });
    }
  }
  servers.sort(byNameThenUrl);
  excluded.sort(byNameThenUrl);
  return {
    format: ALLOWLIST_FORMAT_VERSION,
    generatedFrom: options.generatedFrom ?? DEFAULT_POLICY_SOURCE,
    servers,
    excluded,
  };
}

/**
 * The same dependency list as GitHub's enterprise-managed MCP allowlist:
 * only dependencies whose latest check passed become `serverUrl` matchers,
 * and matchers are exact URLs rather than wildcard patterns. Everything else
 * is reported under `excluded`; `include` does not change `managedSettings`.
 */
export function toGitHubAllowlist(
  entries: readonly PolicyExportEntry[],
  options: PolicyExportOptions = {},
): GitHubAllowlistExport {
  const matchers = new Map<string, GitHubServerMatcher>();
  const excluded: AllowlistExclusion[] = [];
  const blocked = new Set(
    entries
      .map(classify)
      .filter((item) => item.kind === 'url' || item.decision !== 'allow')
      .map((item) => item.url),
  );
  for (const entry of entries) {
    const classified = classify(entry);
    if (
      classified.kind === 'url' ||
      classified.decision === 'review' ||
      blocked.has(classified.url)
    ) {
      excluded.push({
        decision: 'review',
        name: entry.name,
        url: classified.url,
        reasons:
          classified.kind === 'server' && classified.decision === 'allow'
            ? ['shared-url-not-passing']
            : classified.reasons,
      });
    } else if (classified.url.includes('*') || classified.protocol !== 'mcp') {
      excluded.push({
        decision: 'review',
        name: entry.name,
        url: classified.url,
        reasons: [
          classified.url.includes('*') ? 'url-wildcard' : 'not-explicit-mcp',
        ],
      });
    } else if (!matchers.has(classified.url)) {
      matchers.set(classified.url, { serverUrl: classified.url });
    }
  }
  const allowedMcpServers = [...matchers.values()].sort((a, b) =>
    a.serverUrl.localeCompare(b.serverUrl, 'en'),
  );
  excluded.sort(byNameThenUrl);
  return {
    generatedFrom: options.generatedFrom ?? DEFAULT_POLICY_SOURCE,
    managedSettings: { allowedMcpServers },
    excluded,
  };
}
