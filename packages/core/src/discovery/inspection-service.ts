import type {
  A2aSummary,
  ArdSummary,
  DiscoveryReport,
  DiscoveryResult,
  InspectionUrlType,
} from '@interfacedelta/contracts';
import {
  ConstrainedHttpsClient,
  discoveryUrl,
  type RetrievalResult,
  type SafeOutboundClient,
} from '../scanner/outbound-boundary';
import {
  parsePublicHttpsEndpoint,
  parsePublicHttpsOrigin,
} from '../scanner/target-policy';
import { observeMcp } from '../mcp/candidates';
import { observeOpenApi } from '../openapi/observe';
import {
  HttpPassiveMcpClient,
  type PassiveMcpClient,
} from '../mcp/passive-client';
import { discoverArdLinks, type ArdLinkDiscovery } from './ard-html';
import { scanSubmittedPageForWebMcp, submittedWebMcpPage } from './webmcp-page';
import { resolveInspectionUrlType } from './inspection-url';
import {
  interpretArdV091,
  sha256,
  validateA2a,
  validateArdPredecessor,
  validateArdV091,
} from './validation';

type Check<Summary extends Record<string, unknown>> = {
  validation: NonNullable<DiscoveryResult['validation']>;
  summary?: Summary;
};
type ProtocolConfig<Summary extends Record<string, unknown>> = {
  path?: string;
  url?: URL;
  validate(document: unknown): Check<Summary>;
  interpret?(document: unknown, summary: Summary): Promise<Summary>;
};
type Inspected<Summary extends Record<string, unknown>> = {
  result: DiscoveryResult<Summary>;
  document?: unknown;
};
const isJsonContentType = (value?: string) =>
  Boolean(
    value
      ?.split(';', 1)[0]
      ?.trim()
      .match(/^(application|text)\/(?:[a-z0-9.+-]*\+)?json$/i),
  );
function retrievalFailure<Summary extends Record<string, unknown>>(
  url: URL,
  result: Extract<RetrievalResult, { ok: false }>,
): DiscoveryResult<Summary> {
  return {
    status: result.code === 'TARGET_BLOCKED' ? 'blocked' : 'unreachable',
    discoveryUrl: url.href,
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    durationMs: result.durationMs,
    redirects: result.redirects,
    warnings: [],
    error: { code: result.code, message: result.message },
  };
}
async function inspectOne<Summary extends Record<string, unknown>>(
  origin: URL,
  client: SafeOutboundClient,
  config: ProtocolConfig<Summary>,
): Promise<Inspected<Summary>> {
  const url = config.url ?? discoveryUrl(origin, config.path!);
  const retrieved = await client.get(url);
  if (!retrieved.ok)
    return { result: retrievalFailure<Summary>(url, retrieved) };
  const base = {
    discoveryUrl: url.href,
    finalUrl: retrieved.finalUrl,
    httpStatus: retrieved.httpStatus,
    contentType: retrieved.contentType,
    bytes: retrieved.body.length,
    durationMs: retrieved.durationMs,
    sha256: sha256(retrieved.body),
    redirects: retrieved.redirects,
    warnings: [
      ...(isJsonContentType(retrieved.contentType)
        ? []
        : ['CONTENT_TYPE_NOT_JSON']),
      // bytes and sha256 then describe only the retained prefix of an error body.
      ...(retrieved.truncated ? ['RESPONSE_BODY_TRUNCATED'] : []),
    ],
  } as const;
  if (retrieved.httpStatus === 404)
    return { result: { ...base, status: 'not_found' } };
  if (retrieved.httpStatus < 200 || retrieved.httpStatus >= 300)
    return {
      result: {
        ...base,
        status: 'unreachable',
        error: {
          code: 'HTTP_ERROR',
          message: `Discovery endpoint returned HTTP ${retrieved.httpStatus}.`,
        },
      },
    };
  let document: unknown;
  try {
    document = JSON.parse(retrieved.body.toString('utf8'));
  } catch {
    return {
      result: {
        ...base,
        status: 'invalid',
        error: {
          code: 'INVALID_JSON',
          message: 'Response body is not valid JSON.',
        },
      },
    };
  }
  const checked = config.validate(document);
  if (!checked.validation.valid)
    return {
      document,
      result: {
        ...base,
        status: 'invalid',
        validation: checked.validation,
        error: {
          code: 'SCHEMA_INVALID',
          message: 'JSON does not match the pinned protocol schema.',
        },
      },
    };
  const summary =
    checked.summary && config.interpret
      ? await config.interpret(document, checked.summary)
      : checked.summary;
  return {
    document,
    result: {
      ...base,
      status: 'valid',
      validation: checked.validation,
      summary,
    },
  };
}
const source = (
  kind: 'well_known' | 'rel' | 'predecessor',
  item: DiscoveryResult<ArdSummary>,
) => ({
  kind,
  url: item.discoveryUrl,
  status: item.status,
  ...(item.summary ? { entries: item.summary.entries } : {}),
});
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(',')}}`
      : JSON.stringify(value);
const signature = (summary: ArdSummary, identifier: string) => {
  const declaration = summary.declarations.find(
    (item) => item.identifier === identifier,
  );
  const inline = summary.mcpServerCardInline?.find(
    (item) => item.identifier === identifier,
  )?.data;
  return canonical({
    identifier,
    displayName: declaration?.displayName,
    type: declaration?.type,
    url: declaration?.url,
    data: inline,
  });
};
function combineArd(
  primary: DiscoveryResult<ArdSummary>,
  predecessor: DiscoveryResult<ArdSummary> | undefined,
  links: DiscoveryResult<ArdSummary>[],
  rel: ArdLinkDiscovery,
): DiscoveryResult<ArdSummary> {
  const effective =
    primary.status === 'not_found' && predecessor ? predecessor : primary;
  const sourceResults = [
    source('well_known', primary),
    ...(predecessor ? [source('predecessor', predecessor)] : []),
    ...links.map((item) => source('rel', item)),
  ];
  const valid = [
    ...(effective.status === 'valid' ? [effective] : []),
    ...links.filter((item) => item.status === 'valid'),
  ];
  const relDiscovery = {
    rootUrl: rel.rootUrl,
    finalUrl: rel.finalUrl,
    status: rel.status,
    linksFound: rel.totalLinks,
    linksUsed: rel.links.length,
    truncated: rel.truncated,
  };
  if (primary.status !== 'valid' && primary.status !== 'not_found')
    return {
      ...primary,
      summary: valid[0]?.summary
        ? { ...valid[0].summary, sources: sourceResults, relDiscovery }
        : undefined,
      warnings: [...primary.warnings, 'ARD_PRIMARY_DEFECT_PRESERVED'],
    };
  if (!valid.length)
    return {
      ...effective,
      summary: effective.summary
        ? { ...effective.summary, sources: sourceResults, relDiscovery }
        : undefined,
    };
  const byId = new Map<
    string,
    { summary: ArdSummary; sources: Set<string>; signature: string }
  >();
  const conflicts = new Map<string, Set<string>>();
  for (const item of valid)
    for (const declaration of item.summary?.declarations ?? []) {
      const priorConflict = conflicts.get(declaration.identifier);
      if (priorConflict) {
        priorConflict.add(item.discoveryUrl);
        continue;
      }
      const sig = signature(item.summary!, declaration.identifier),
        existing = byId.get(declaration.identifier);
      if (!existing)
        byId.set(declaration.identifier, {
          summary: item.summary!,
          sources: new Set([item.discoveryUrl]),
          signature: sig,
        });
      else if (existing.signature === sig)
        existing.sources.add(item.discoveryUrl);
      else {
        const set =
          conflicts.get(declaration.identifier) ?? new Set(existing.sources);
        set.add(item.discoveryUrl);
        conflicts.set(declaration.identifier, set);
        byId.delete(declaration.identifier);
      }
    }
  const accepted = [...byId.entries()].sort(([a], [b]) => a.localeCompare(b));
  const declarations = accepted.map(([id, { summary }]) =>
    summary.declarations.find((item) => item.identifier === id)!,
  );
  const inline = accepted.flatMap(
    ([id, { summary }]) =>
      summary.mcpServerCardInline?.filter((item) => item.identifier === id) ??
      [],
  );
  const urls = declarations
    .filter(
      (item) => item.type === 'application/mcp-server-card+json' && item.url,
    )
    .map((item) => item.url!);
  const summaries = valid.map((item) => item.summary!);
  const base = effective.status === 'valid' ? effective : valid[0]!;
  return {
    ...base,
    status: 'valid',
    warnings: [
      ...new Set([
        ...base.warnings,
        ...(rel.truncated ? ['ARD_REL_LINK_LIMIT'] : []),
        ...(conflicts.size ? ['ARD_SOURCE_CONFLICT'] : []),
      ]),
    ].sort(),
    summary: {
      ...base.summary!,
      entries: declarations.length,
      entryTypes: [...new Set(declarations.map((item) => item.type))].sort(),
      mcpServerCardUrls: [...new Set(urls)].sort(),
      mcpServerCardInline: inline,
      declarations,
      sources: sourceResults,
      relDiscovery,
      conflicts: [...conflicts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([identifier, urls]) => ({
          identifier,
          sourceUrls: [...urls].sort(),
        })),
      conformanceWarnings: [
        ...new Set(summaries.flatMap((item) => item.conformanceWarnings ?? [])),
      ].sort(),
      jsonLd: {
        baseContextApplied: true,
        coreTermIris: [
          ...new Set(
            summaries.flatMap((item) => item.jsonLd?.coreTermIris ?? []),
          ),
        ].sort(),
        extensionTermIris: [
          ...new Set(
            summaries.flatMap((item) => item.jsonLd?.extensionTermIris ?? []),
          ),
        ].sort(),
        externalContextsNotResolved: [
          ...new Set(
            summaries.flatMap(
              (item) => item.jsonLd?.externalContextsNotResolved ?? [],
            ),
          ),
        ].sort(),
        coreTermsComplete: summaries.every(
          (item) => item.jsonLd?.coreTermsComplete !== false,
        ),
      },
    },
  };
}
export async function inspectOrigin(
  inputUrl: string,
  client: SafeOutboundClient = new ConstrainedHttpsClient(),
  now: () => Date = () => new Date(),
  mcpEndpoint?: string,
  mcpClient: PassiveMcpClient = new HttpPassiveMcpClient(client),
  requestedType: InspectionUrlType = 'auto',
): Promise<DiscoveryReport> {
  const origin = parsePublicHttpsOrigin(inputUrl);
  const submittedUrl = parsePublicHttpsEndpoint(inputUrl);
  const resolvedType = resolveInspectionUrlType(submittedUrl, requestedType);
  const current = {
    ...(resolvedType === 'ard'
      ? { url: submittedUrl }
      : { path: '/.well-known/ard.json' }),
    validate: validateArdV091,
    interpret: interpretArdV091,
  };
  const webMcpPage =
    resolvedType === 'service'
      ? submittedWebMcpPage(origin, submittedUrl)
      : undefined;
  const [primary, a2a, rel, submittedPage] = await Promise.all([
    inspectOne<ArdSummary>(origin, client, current),
    inspectOne<A2aSummary>(origin, client, {
      ...(resolvedType === 'a2a'
        ? { url: submittedUrl }
        : { path: '/.well-known/agent-card.json' }),
      validate: validateA2a,
    }),
    discoverArdLinks(origin, client),
    webMcpPage
      ? scanSubmittedPageForWebMcp(origin, webMcpPage, client)
      : undefined,
  ]);
  const predecessor =
    primary.result.status === 'not_found'
      ? await inspectOne<ArdSummary>(origin, client, {
          path: '/.well-known/ai-catalog.json',
          validate: validateArdPredecessor,
        })
      : undefined;
  const already = new Set(
    [primary.result.discoveryUrl, predecessor?.result.discoveryUrl].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const linkResults: DiscoveryResult<ArdSummary>[] = [];
  for (const href of rel.links) {
    if (already.has(href)) continue;
    linkResults.push(
      (
        await inspectOne<ArdSummary>(origin, client, {
          url: new URL(href),
          validate: validateArdV091,
          interpret: interpretArdV091,
        })
      ).result,
    );
  }
  const ard = combineArd(primary.result, predecessor?.result, linkResults, rel);
  const effectiveMcpEndpoint =
    resolvedType === 'mcp' ? submittedUrl.href : mcpEndpoint;
  const [mcp, openapi] = await Promise.all([
    observeMcp(
      origin,
      effectiveMcpEndpoint,
      ard.status === 'valid' ? (ard.summary?.mcpServerCardUrls ?? []) : [],
      mcpClient,
      client,
      ard.status === 'valid' ? (ard.summary?.mcpServerCardInline ?? []) : [],
    ),
    observeOpenApi(
      origin,
      ard.status === 'valid' ? ard.summary : undefined,
      client,
      resolvedType === 'openapi' ? submittedUrl : undefined,
    ),
  ]);
  return {
    inputUrl,
    origin: origin.origin,
    inspectedAt: now().toISOString(),
    submitted: {
      url: submittedUrl.href,
      requestedType,
      resolvedType,
      ...(resolvedType === 'service'
        ? {}
        : { directlyInspected: resolvedType }),
    },
    ard,
    a2a: a2a.result,
    mcp,
    openapi,
    webmcp: submittedPage ? { ...rel.webmcp, submittedPage } : rel.webmcp,
  };
}
