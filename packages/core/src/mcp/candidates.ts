import type {
  McpCandidateResult,
  McpCandidateSource,
  McpObservation,
  ServerCardObservation,
} from '@interfacedelta/contracts';
import type { SafeOutboundClient } from '../scanner/outbound-boundary';
import { parsePublicHttpsEndpoint } from '../scanner/target-policy';
import type { PassiveMcpClient } from './passive-client';
import { observeInlineServerCard, observeServerCard } from './server-card';

export const MCP_CANDIDATE_LIMITS = {
  explicit: 1,
  sameOriginServerCards: 3,
  inspected: 4,
} as const;
type Candidate = {
  endpoint: string;
  sources: Set<McpCandidateSource>;
  explicit: boolean;
  eligible: boolean;
  origin?: string;
  serverCardUrl?: string;
  remotePolicy?:
    'eligible' | 'remote_declared_not_probed' | 'configuration_required';
  reason?: string;
};

export async function observeMcp(
  origin: URL,
  explicit: string | undefined,
  serverCardUrls: readonly string[],
  client: PassiveMcpClient,
  outbound: SafeOutboundClient,
  inlineServerCards: readonly {
    identifier: string;
    data: Readonly<Record<string, unknown>>;
  }[] = [],
): Promise<McpObservation> {
  const cards: ServerCardObservation[] = inlineServerCards.map(
    (entry, index) =>
      index < MCP_CANDIDATE_LIMITS.sameOriginServerCards
        ? observeInlineServerCard(origin, entry.identifier, { ...entry.data })
        : {
            source: 'ard_declared',
            serverCardUrl: entry.identifier,
            status: 'declared_not_fetched',
            fetched: false,
            inline: true,
            remotes: [],
            error: {
              code: 'SERVER_CARD_FETCH_LIMIT',
              message:
                'Inline Server Card omitted by the Server Card processing limit.',
            },
          },
  );
  let fetchedCards = Math.min(
    inlineServerCards.length,
    MCP_CANDIDATE_LIMITS.sameOriginServerCards,
  );
  for (const cardUrl of [...new Set(serverCardUrls)].sort()) {
    let sameOrigin = false;
    try {
      sameOrigin = parsePublicHttpsEndpoint(cardUrl).origin === origin.origin;
    } catch {
      /* recorded by observer */
    }
    if (
      sameOrigin &&
      fetchedCards >= MCP_CANDIDATE_LIMITS.sameOriginServerCards
    ) {
      cards.push({
        source: 'ard_declared',
        serverCardUrl: cardUrl,
        status: 'declared_not_fetched',
        fetched: false,
        remotes: [],
        error: {
          code: 'SERVER_CARD_FETCH_LIMIT',
          message: 'Server Card omitted by the Server Card fetch limit.',
        },
      });
      continue;
    }
    if (sameOrigin) fetchedCards++;
    cards.push(await observeServerCard(origin, cardUrl, outbound));
  }

  const candidates = new Map<string, Candidate>();
  const add = (
    raw: string,
    source: McpCandidateSource,
    details: Partial<Candidate> = {},
  ) => {
    let endpoint: URL;
    try {
      endpoint = parsePublicHttpsEndpoint(raw);
    } catch {
      const key = `invalid:${raw}`;
      const found = candidates.get(key) ?? {
        endpoint: raw,
        sources: new Set<McpCandidateSource>(),
        explicit: false,
        eligible: false,
      };
      found.sources.add(source);
      found.explicit ||= source === 'user_supplied';
      Object.assign(found, details);
      candidates.set(key, found);
      return;
    }
    const found = candidates.get(endpoint.href) ?? {
      endpoint: endpoint.href,
      sources: new Set<McpCandidateSource>(),
      explicit: false,
      eligible: true,
      origin: endpoint.origin,
    };
    found.sources.add(source);
    found.explicit ||= source === 'user_supplied';
    if (details.serverCardUrl && !found.serverCardUrl)
      found.serverCardUrl = details.serverCardUrl;
    if (details.remotePolicy) found.remotePolicy = details.remotePolicy;
    if (details.reason) found.reason = details.reason;
    candidates.set(endpoint.href, found);
  };
  if (explicit) add(explicit, 'user_supplied');
  for (const card of cards.filter((card) => card.status === 'valid'))
    for (const remote of card.remotes.filter(
      (remote) => remote.transport === 'streamable-http',
    ))
      add(remote.remoteEndpoint, 'ard_declared', {
        serverCardUrl: card.serverCardUrl,
        remotePolicy:
          remote.probePolicy === 'eligible'
            ? 'eligible'
            : remote.probePolicy === 'remote_declared_not_probed'
              ? 'remote_declared_not_probed'
              : 'configuration_required',
        reason: remote.reason,
      });

  let inspected = 0;
  const results: McpCandidateResult[] = [];
  for (const candidate of [...candidates.values()].sort((a, b) =>
    a.endpoint.localeCompare(b.endpoint, 'en'),
  )) {
    const sources = [...candidate.sources].sort() as McpCandidateSource[];
    if (!candidate.eligible) {
      results.push({
        endpoint: candidate.endpoint,
        sources,
        probePolicy: candidate.explicit ? 'inspected' : 'declared_not_probed',
        status: candidate.explicit ? 'blocked' : 'configuration_required',
        targetOrigin: '',
        syntacticallyEligible: false,
        serverCardUrl: candidate.serverCardUrl,
        remoteTransport: candidate.serverCardUrl
          ? 'streamable-http'
          : undefined,
        error: {
          code: 'INVALID_MCP_ENDPOINT',
          message:
            candidate.reason ??
            'MCP endpoint does not meet the public HTTPS policy.',
        },
      });
      continue;
    }
    const mayProbe =
      candidate.explicit || candidate.remotePolicy === 'eligible';
    if (!mayProbe) {
      results.push({
        endpoint: candidate.endpoint,
        sources,
        probePolicy: 'declared_not_probed',
        status:
          candidate.remotePolicy === 'configuration_required'
            ? 'configuration_required'
            : 'declared_not_probed',
        targetOrigin: candidate.origin!,
        syntacticallyEligible: true,
        serverCardUrl: candidate.serverCardUrl,
        remoteTransport: 'streamable-http',
        error: {
          code:
            candidate.remotePolicy === 'configuration_required'
              ? 'SERVER_CARD_CONFIGURATION_REQUIRED'
              : 'REMOTE_CROSS_ORIGIN_NOT_PROBED',
          message:
            candidate.reason ??
            'Derived remote endpoint was not automatically contacted.',
        },
      });
      continue;
    }
    if (inspected >= MCP_CANDIDATE_LIMITS.inspected) {
      results.push({
        endpoint: candidate.endpoint,
        sources,
        probePolicy: 'declared_not_probed',
        status: 'declared_not_probed',
        targetOrigin: candidate.origin!,
        syntacticallyEligible: true,
        serverCardUrl: candidate.serverCardUrl,
        remoteTransport: candidate.serverCardUrl
          ? 'streamable-http'
          : undefined,
        error: {
          code: 'MCP_CANDIDATE_LIMIT',
          message:
            'Eligible MCP endpoint was omitted by the aggregate inspection limit.',
        },
      });
      continue;
    }
    inspected++;
    const result = await client.inspect(new URL(candidate.endpoint), sources);
    results.push({
      ...result,
      serverCardUrl: candidate.serverCardUrl,
      remoteTransport: candidate.serverCardUrl ? 'streamable-http' : undefined,
    });
  }
  return {
    totalDeclared: candidates.size,
    totalInspected: inspected,
    totalOmitted: results.length - inspected,
    serverCards: cards,
    candidates: results,
  };
}
