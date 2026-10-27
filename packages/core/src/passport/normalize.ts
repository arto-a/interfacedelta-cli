import type {
  AgentPassport,
  DiscoveryReport,
  WebMcpDeclarativeTool,
  WebMcpPageScan,
} from '@interfacedelta/contracts';
import {
  CAPABILITY_SEMANTIC_PROJECTION_VERSION,
  PASSPORT_SCHEMA_VERSION,
  PASSPORT_SEMANTIC_PROJECTION_VERSION,
  passportSchema,
  structuredPassportSchema,
} from '@interfacedelta/contracts';
import {
  canonicalJson,
  canonicalSha256,
  canonicalUrl,
  stableId,
} from './canonical-json';
import { analyzeConsistency } from './consistency';
import { summarizePaymentDeclaration } from '../openapi/payment-info';

const fingerprint = (projection: unknown) => ({
  algorithm: 'sha256' as const,
  canonicalization: 'RFC8785' as const,
  projectionVersion: CAPABILITY_SEMANTIC_PROJECTION_VERSION,
  value: canonicalSha256(projection),
});
const relationship = (origin: string, url: string) => {
  try {
    return new URL(url).origin === origin
      ? ('same_origin' as const)
      : ('cross_origin' as const);
  } catch {
    return 'cross_origin' as const;
  }
};
const sortById = <T extends { id: string }>(items: T[]) =>
  items.sort((a, b) => a.id.localeCompare(b.id, 'en'));
const normalizedJson = (value: unknown): Record<string, unknown> =>
  JSON.parse(canonicalJson(value)) as Record<string, unknown>;

// Query and fragment are dropped: form actions often carry per-request tokens.
const stableAction = (action: string | undefined, origin: string) => {
  if (!action) return undefined;
  try {
    const url = new URL(action);
    return url.origin === origin
      ? url.pathname
      : `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
};
const webMcpToolMetadata = (tool: WebMcpDeclarativeTool, origin: string) =>
  normalizedJson({
    autoSubmit: tool.autoSubmit,
    method: tool.method,
    actionRelationship: tool.actionRelationship,
    action: stableAction(tool.action, origin),
    controls: tool.controls.map((control) => ({
      name: control.name,
      element: control.element,
      type: control.type,
      required: control.required,
      description: control.description,
      optionCount: control.optionCount,
      occurrences: control.occurrences,
    })),
    controlCount: tool.controlCount,
    controlsTruncated: tool.controlsTruncated,
  });

export function passportSemanticProjection(passport: AgentPassport) {
  const value = structuredPassportSchema.parse(passport);
  return {
    schemaVersion: value.schemaVersion,
    subject: { origin: value.subject.origin },
    protocols: value.protocols,
    artifacts: value.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      protocol: artifact.protocol,
      url: artifact.url,
      status: artifact.status,
      validationStatus: artifact.validationStatus,
      schemaRevision: artifact.schemaRevision,
      provenance: artifact.provenance,
    })),
    endpoints: value.endpoints,
    identityAssertions: value.identityAssertions,
    accessAssertions: value.accessAssertions,
    inventoryGroups: value.inventoryGroups,
    capabilities: value.capabilities,
    consistency: {
      findings: value.consistency.findings.map(
        ({ code, status, subjectRefs, evidenceRefs }) => ({
          code,
          status,
          subjectRefs,
          evidenceRefs,
        }),
      ),
    },
  };
}

export const computePassportFingerprint = (passport: AgentPassport): string =>
  canonicalSha256(passportSemanticProjection(passport));

export type NormalizeOptions = {
  /** A target-scope-v2 page-target's watched path; omitted for every other target. */
  monitoredPage?: string | null;
};

export function normalizeDiscoveryReport(
  report: DiscoveryReport,
  options: NormalizeOptions = {},
): AgentPassport {
  const origin = new URL(report.origin);
  const artifacts: AgentPassport['artifacts'][number][] = [];
  const endpoints: AgentPassport['endpoints'][number][] = [];
  const identities: AgentPassport['identityAssertions'][number][] = [];
  const access: AgentPassport['accessAssertions'][number][] = [];
  const inventoryGroups: AgentPassport['inventoryGroups'][number][] = [];
  const capabilities: AgentPassport['capabilities'][number][] = [];
  const addArtifact = (
    kind: AgentPassport['artifacts'][number]['kind'],
    protocol: AgentPassport['artifacts'][number]['protocol'],
    url: string,
    status: string,
    validation: boolean | undefined,
    sha: string | undefined,
    revision: string | undefined,
    provenance: string[],
  ) => {
    const normalized = canonicalUrl(url);
    const item = {
      id: stableId('artifact', kind, normalized),
      kind,
      protocol,
      url: normalized,
      status,
      validationStatus:
        validation === true
          ? ('valid' as const)
          : validation === false
            ? ('invalid' as const)
            : ('not_validated' as const),
      bodySha256: sha,
      schemaRevision: revision,
      provenance: [...new Set(provenance)].sort(),
    };
    artifacts.push(item);
    return item;
  };
  const ard = addArtifact(
    'ard.catalog',
    'ard',
    report.ard.discoveryUrl,
    report.ard.status,
    report.ard.validation?.valid,
    report.ard.sha256,
    report.ard.validation?.schemaRevision,
    [
      report.submitted?.directlyInspected === 'ard'
        ? 'user_supplied'
        : 'discovery:ard',
    ],
  );
  const a2a = addArtifact(
    'a2a.agent-card',
    'a2a',
    report.a2a.discoveryUrl,
    report.a2a.status,
    report.a2a.validation?.valid,
    report.a2a.sha256,
    report.a2a.validation?.schemaRevision,
    [
      report.submitted?.directlyInspected === 'a2a'
        ? 'user_supplied'
        : 'discovery:a2a',
    ],
  );
  const cardRefs = new Map<string, string>();
  for (const card of report.mcp.serverCards) {
    const artifact = addArtifact(
      'mcp.server-card.experimental',
      'mcp-server-card',
      card.serverCardUrl,
      card.status,
      card.validation?.valid,
      card.network?.sha256,
      card.validation?.schemaRevision,
      ['discovery:ard', `server-card:${canonicalUrl(card.serverCardUrl)}`],
    );
    cardRefs.set(canonicalUrl(card.serverCardUrl), artifact.id);
    if (card.identity)
      for (const [field, value] of Object.entries(card.identity).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ))
        identities.push({
          id: stableId(
            'identity',
            'mcp-server-card',
            artifact.id,
            field,
            value,
          ),
          sourceProtocol: 'mcp-server-card',
          sourceRef: artifact.id,
          assertionType: 'experimental_server_card_identity',
          field,
          value,
          trust: 'self_reported',
        });
    for (const remote of card.remotes) {
      if (remote.transport !== 'streamable-http' || !remote.concrete) continue;
      const url = canonicalUrl(remote.remoteEndpoint);
      const candidate = report.mcp.candidates.find(
        (item) => canonicalUrl(item.endpoint) === url,
      );
      endpoints.push({
        id: stableId('endpoint', 'mcp', url),
        protocol: 'mcp',
        role: 'mcp.streamable-http',
        url,
        originRelationship: relationship(report.origin, url),
        relationship:
          candidate?.probePolicy === 'inspected'
            ? 'declared_and_inspected'
            : 'declared',
        declarationSources: ['server_card_declared'],
        observationStatus: candidate?.status ?? remote.probePolicy,
        protocolVersion: candidate?.protocol?.version,
        artifactRefs: [artifact.id],
      });
      if (
        remote.headersDeclared ||
        remote.probePolicy === 'configuration_required'
      )
        access.push({
          id: stableId('access', 'configuration', artifact.id, url),
          kind: 'configuration_required',
          sourceRef: artifact.id,
          endpointId: stableId('endpoint', 'mcp', url),
          name: 'server_card_configuration',
          value: remote.reason,
        });
    }
  }
  if (report.a2a.status === 'valid' && report.a2a.summary) {
    inventoryGroups.push({
      id: stableId('inventory', 'a2a.skill', a2a.id),
      kind: 'a2a.skill',
      sourceRef: a2a.id,
      attempted: true,
      complete: true,
      itemCount: report.a2a.summary.skills.length,
    });
    identities.push({
      id: stableId('identity', 'a2a', a2a.id, 'name', report.a2a.summary.name),
      sourceProtocol: 'a2a',
      sourceRef: a2a.id,
      assertionType: 'agent_card_identity',
      field: 'name',
      value: report.a2a.summary.name,
      trust: 'self_reported',
    });
    if (report.a2a.summary.agentVersion)
      identities.push({
        id: stableId(
          'identity',
          'a2a',
          a2a.id,
          'version',
          report.a2a.summary.agentVersion,
        ),
        sourceProtocol: 'a2a',
        sourceRef: a2a.id,
        assertionType: 'agent_card_identity',
        field: 'version',
        value: report.a2a.summary.agentVersion,
        trust: 'self_reported',
      });
    for (const scheme of report.a2a.summary.securitySchemes)
      access.push({
        id: stableId('access', 'a2a', a2a.id, scheme),
        kind: 'declared_security_scheme',
        sourceRef: a2a.id,
        name: scheme,
      });
    for (const item of report.a2a.summary.interfaces) {
      if (!item.url) continue;
      const url = canonicalUrl(item.url);
      endpoints.push({
        id: stableId('endpoint', 'a2a', url, item.protocolBinding),
        protocol: 'a2a',
        role: 'a2a.interface',
        url,
        originRelationship: relationship(report.origin, url),
        relationship: 'declared',
        declarationSources: ['a2a_agent_card'],
        observationStatus: 'declared_not_probed',
        protocolVersion: item.protocolVersion || undefined,
        artifactRefs: [a2a.id],
      });
    }
    for (const skill of report.a2a.summary.skills) {
      const sourceRef = a2a.id;
      const projection = {
        kind: 'a2a.skill',
        protocolKey: skill.id,
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        examples: skill.examples,
        inputModes: skill.inputModes,
        outputModes: skill.outputModes,
      };
      capabilities.push({
        id: stableId('capability', 'a2a.skill', sourceRef, skill.id),
        kind: 'a2a.skill',
        protocol: 'a2a',
        protocolKey: skill.id,
        name: skill.name,
        title: skill.name,
        description: skill.description,
        sourceRef,
        metadata: {
          tags: skill.tags,
          examples: skill.examples,
          inputModes: skill.inputModes,
          outputModes: skill.outputModes,
        },
        inventory: { complete: true },
        fingerprint: fingerprint(projection),
        provenance: ['discovery:a2a', sourceRef],
      });
    }
  }
  for (const candidate of report.mcp.candidates) {
    const url = canonicalUrl(candidate.endpoint);
    let endpoint = endpoints.find(
      (item) => item.protocol === 'mcp' && item.url === url,
    );
    if (!endpoint) {
      const sources = [...candidate.sources].sort();
      endpoint = {
        id: stableId('endpoint', 'mcp', url),
        protocol: 'mcp',
        role: 'mcp.streamable-http',
        url,
        originRelationship: relationship(report.origin, url),
        relationship:
          candidate.probePolicy === 'inspected'
            ? 'explicitly_inspected'
            : 'declared',
        declarationSources: sources,
        observationStatus: candidate.status,
        protocolVersion: candidate.protocol?.version,
        artifactRefs: candidate.serverCardUrl
          ? [cardRefs.get(canonicalUrl(candidate.serverCardUrl))!].filter(
              Boolean,
            )
          : [],
      };
      endpoints.push(endpoint);
    } else
      Object.assign(endpoint, {
        relationship:
          candidate.probePolicy === 'inspected'
            ? 'declared_and_inspected'
            : endpoint.relationship,
        declarationSources: [
          ...new Set([...endpoint.declarationSources, ...candidate.sources]),
        ].sort(),
        observationStatus: candidate.status,
        protocolVersion:
          candidate.protocol?.version ?? endpoint.protocolVersion,
      });
    if (candidate.server?.selfReportedIdentity)
      for (const [field, value] of Object.entries(
        candidate.server.selfReportedIdentity,
      ).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ))
        identities.push({
          id: stableId('identity', 'mcp', endpoint.id, field, value),
          sourceProtocol: 'mcp',
          sourceRef: endpoint.id,
          assertionType: 'implementation_identity',
          field,
          value,
          trust: 'self_reported',
        });
    if (candidate.auth)
      access.push({
        id: stableId(
          'access',
          'mcp-http',
          endpoint.id,
          String(candidate.auth.httpStatus),
        ),
        kind: 'observed_http_access',
        sourceRef: endpoint.id,
        endpointId: endpoint.id,
        name: candidate.status,
        value: candidate.auth.wwwAuthenticate,
      });
    for (const [kind, inventory] of [
      ['mcp.tool', candidate.tools],
      ['mcp.resource', candidate.resources],
      ['mcp.prompt', candidate.prompts],
    ] as const) {
      if (!inventory) continue;
      inventoryGroups.push({
        id: stableId('inventory', kind, endpoint.id),
        kind,
        sourceRef: endpoint.id,
        sourceEndpointId: endpoint.id,
        attempted: inventory.attempted,
        complete: inventory.complete,
        itemCount: inventory.count,
        truncatedReason: inventory.truncatedReason,
        failureCode: inventory.failureCode,
      });
      for (const item of inventory.items) {
        const protocolKey =
          kind === 'mcp.resource'
            ? (item as { uri: string }).uri
            : (item as { name: string }).name;
        const projection = {
          kind,
          protocolKey,
          item,
          protocolVersion: candidate.protocol?.version,
        };
        capabilities.push({
          id: stableId('capability', kind, endpoint.id, protocolKey),
          kind,
          protocol: 'mcp',
          protocolKey,
          name: (item as { name: string }).name,
          title: (item as { title?: string }).title,
          description: (item as { description?: string }).description,
          sourceRef: endpoint.id,
          sourceEndpointId: endpoint.id,
          metadata: normalizedJson(item),
          inventory: {
            complete: inventory.complete,
            truncatedReason: inventory.truncatedReason,
          },
          fingerprint: fingerprint(projection),
          provenance: [
            endpoint.id,
            `mcp-inventory:${url}:${kind.split('.')[1]}s`,
          ],
        });
      }
    }
  }
  const openapi = report.openapi ?? {
    totalDeclared: 0,
    totalFetched: 0,
    totalOmitted: 0,
    complete: true,
    documents: [],
  };
  for (const document of openapi.documents) {
    const discoveryProvenance =
      document.provenance === 'user_supplied'
        ? 'user_supplied'
        : 'discovery:ard';
    const artifact = addArtifact(
      'openapi.document',
      'openapi',
      document.artifactUrl,
      document.status,
      document.validation?.valid,
      document.sha256,
      document.validation?.schemaRevision,
      [discoveryProvenance, document.provenance, document.declarationId],
    );
    if (document.title)
      identities.push({
        id: stableId(
          'identity',
          'openapi',
          artifact.id,
          'title',
          document.title,
        ),
        sourceProtocol: 'openapi',
        sourceRef: artifact.id,
        assertionType: 'openapi_info',
        field: 'title',
        value: document.title,
        trust: 'self_reported',
      });
    if (document.apiVersion)
      identities.push({
        id: stableId(
          'identity',
          'openapi',
          artifact.id,
          'version',
          document.apiVersion,
        ),
        sourceProtocol: 'openapi',
        sourceRef: artifact.id,
        assertionType: 'openapi_info',
        field: 'version',
        value: document.apiVersion,
        trust: 'self_reported',
      });
    for (const scheme of document.securitySchemes)
      access.push({
        id: stableId('access', 'openapi', artifact.id, scheme.name),
        kind: 'declared_security_scheme',
        sourceRef: artifact.id,
        name: scheme.name,
        value: scheme.type,
      });
    inventoryGroups.push({
      id: stableId('inventory', 'openapi.operation', artifact.id),
      kind: 'openapi.operation',
      sourceRef: artifact.id,
      attempted: document.status === 'valid',
      complete: document.status === 'valid' && document.complete,
      itemCount: document.operations.length,
      truncatedReason: document.complete
        ? undefined
        : document.limitationCodes.join(',').slice(0, 512),
      failureCode: document.error?.code,
    });
    for (const rawOperation of document.operations) {
      // null (checked, none declared) is kept distinct from an absent key (never checked) so drift can tell observer coverage from a publisher change.
      const payment =
        summarizePaymentDeclaration(rawOperation.paymentDeclaration) ?? null;
      // Amounts stay in the Discovery Report; the Passport carries only the summary.
      const operation = { ...rawOperation, paymentDeclaration: payment };
      const projection = {
        kind: 'openapi.operation',
        protocolKey: operation.key,
        operation,
        openapiVersion: document.openapiVersion,
      };
      capabilities.push({
        id: stableId(
          'capability',
          'openapi.operation',
          artifact.id,
          operation.key,
        ),
        kind: 'openapi.operation',
        protocol: 'openapi',
        protocolKey: operation.key,
        name: operation.operationId ?? operation.key,
        title: operation.summary,
        sourceRef: artifact.id,
        metadata: normalizedJson({
          method: operation.method,
          path: operation.path,
          operationId: operation.operationId,
          tags: operation.tags,
          parameters: operation.parameters,
          requestBody: operation.requestBody,
          responses: operation.responses,
          securityDeclared: operation.securityDeclared,
          paymentDeclaration: payment,
          explicitCapability: operation.explicitCapability,
          limitationCodes: operation.limitationCodes,
        }),
        inventory: {
          complete: document.complete && operation.complete,
          truncatedReason: operation.complete
            ? undefined
            : operation.limitationCodes.join(',').slice(0, 512),
        },
        fingerprint: fingerprint(projection),
        provenance: [discoveryProvenance, artifact.id, document.provenance],
      });
    }
  }
  // WebMCP enters the Passport only when a named declarative tool was seen, so
  // routine root-page failures on sites without WebMCP never move fingerprints.
  const webMcpTools: WebMcpDeclarativeTool[] = [];
  let webMcpComplete = true;
  const addWebMcpPage = (
    scan: WebMcpPageScan | undefined,
    kind: 'webmcp.root-html' | 'webmcp.page-html',
    discovery: 'discovery:root-html' | 'discovery:monitored-page-html',
  ) => {
    if (scan?.status !== 'observed' || !scan.tools.length) return;
    const artifact = addArtifact(
      kind,
      'webmcp',
      scan.sourceUrl,
      'observed',
      undefined,
      undefined,
      undefined,
      [discovery, scan.observationVersion],
    );
    const tools: WebMcpDeclarativeTool[] = [];
    const seen = new Set<string>();
    for (const tool of scan.tools)
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        tools.push(tool);
      }
    const duplicates = tools.length < scan.tools.length;
    const complete = !scan.toolsTruncated && !duplicates;
    webMcpComplete &&= complete;
    webMcpTools.push(...tools);
    inventoryGroups.push({
      id: stableId('inventory', 'webmcp.tool', artifact.id),
      kind: 'webmcp.tool',
      sourceRef: artifact.id,
      attempted: true,
      complete,
      itemCount: tools.length,
      truncatedReason: scan.toolsTruncated
        ? 'tool_limit'
        : duplicates
          ? 'duplicate_tool_name'
          : undefined,
    });
    for (const tool of tools) {
      const metadata = webMcpToolMetadata(tool, report.origin);
      capabilities.push({
        id: stableId('capability', 'webmcp.tool', artifact.id, tool.name),
        kind: 'webmcp.tool',
        protocol: 'webmcp',
        protocolKey: tool.name,
        name: tool.name,
        description: tool.description,
        sourceRef: artifact.id,
        metadata,
        inventory: {
          complete,
          truncatedReason: complete ? undefined : 'webmcp_inventory_incomplete',
        },
        fingerprint: fingerprint({
          kind: 'webmcp.tool',
          protocolKey: tool.name,
          description: tool.description,
          metadata,
        }),
        provenance: [discovery, artifact.id],
      });
    }
  };
  addWebMcpPage(report.webmcp, 'webmcp.root-html', 'discovery:root-html');
  // Only a page-target's own watched page enters; a one-time submitted page
  // stays in the Discovery Report so origin targets never flap between scans.
  const page = report.webmcp?.submittedPage;
  if (options.monitoredPage && page) {
    let path: string | undefined;
    try {
      const url = new URL(page.sourceUrl);
      if (url.origin === origin.origin) path = url.pathname;
    } catch {
      path = undefined;
    }
    if (path === options.monitoredPage)
      addWebMcpPage(page, 'webmcp.page-html', 'discovery:monitored-page-html');
  }
  const endpointMap = new Map<string, AgentPassport['endpoints'][number]>();
  for (const item of endpoints) {
    const existing = endpointMap.get(item.id);
    if (!existing) endpointMap.set(item.id, item);
    else
      endpointMap.set(item.id, {
        ...existing,
        declarationSources: [
          ...new Set([
            ...existing.declarationSources,
            ...item.declarationSources,
          ]),
        ].sort(),
        artifactRefs: [
          ...new Set([...existing.artifactRefs, ...item.artifactRefs]),
        ].sort(),
        relationship:
          existing.relationship === 'declared_and_inspected' ||
          item.relationship === 'declared_and_inspected'
            ? 'declared_and_inspected'
            : existing.relationship,
        observationStatus: item.observationStatus,
        protocolVersion: item.protocolVersion ?? existing.protocolVersion,
      });
  }
  endpoints.splice(0, endpoints.length, ...endpointMap.values());
  const protocols: AgentPassport['protocols'] = [
    {
      protocol: 'ard',
      status: report.ard.status,
      revision: report.ard.validation?.schemaRevision,
      artifactRefs: [ard.id],
      endpointRefs: [],
    },
    {
      protocol: 'a2a',
      status: report.a2a.status,
      revision: report.a2a.validation?.schemaRevision,
      artifactRefs: [a2a.id],
      endpointRefs: endpoints
        .filter((item) => item.protocol === 'a2a')
        .map((item) => item.id)
        .sort(),
    },
    {
      protocol: 'mcp-server-card',
      status: report.mcp.serverCards.length
        ? report.mcp.serverCards.some((item) => item.status === 'valid')
          ? 'valid'
          : 'observed'
        : 'not_detected',
      revision: report.mcp.serverCards.find((item) => item.validation)
        ?.validation?.schemaRevision,
      artifactRefs: artifacts
        .filter((item) => item.kind === 'mcp.server-card.experimental')
        .map((item) => item.id)
        .sort(),
      endpointRefs: [],
    },
    {
      protocol: 'openapi',
      status: openapi.documents.length
        ? openapi.documents.some((item) => item.status === 'valid')
          ? 'valid'
          : 'observed'
        : 'not_detected',
      revision:
        [
          ...new Set(
            openapi.documents
              .map((item) => item.openapiVersion)
              .filter((item): item is string => Boolean(item)),
          ),
        ]
          .sort()
          .join(',') || undefined,
      artifactRefs: artifacts
        .filter((item) => item.kind === 'openapi.document')
        .map((item) => item.id)
        .sort(),
      endpointRefs: [],
    },
    {
      protocol: 'webmcp',
      status: webMcpTools.length ? 'observed' : 'not_detected',
      artifactRefs: artifacts
        .filter(
          (item) =>
            item.kind === 'webmcp.root-html' ||
            item.kind === 'webmcp.page-html',
        )
        .map((item) => item.id)
        .sort(),
      endpointRefs: [],
    },
    {
      protocol: 'mcp',
      status: report.mcp.candidates.length
        ? report.mcp.candidates.some(
            (item) => item.status === 'valid' || item.status === 'truncated',
          )
          ? 'valid'
          : 'observed'
        : 'not_detected',
      revision:
        [
          ...new Set(
            report.mcp.candidates
              .map((item) => item.protocol?.version)
              .filter((item): item is string => Boolean(item)),
          ),
        ]
          .sort()
          .join(',') || undefined,
      artifactRefs: [],
      endpointRefs: endpoints
        .filter((item) => item.protocol === 'mcp')
        .map((item) => item.id)
        .sort(),
    },
  ];
  const base = {
    schemaVersion: PASSPORT_SCHEMA_VERSION,
    subject: {
      origin: report.origin,
      hostname: origin.hostname,
      scheme: 'https' as const,
      effectivePort: 443 as const,
      inputUrl: report.inputUrl,
    },
    observation: {
      inspectedAt: report.inspectedAt,
      discoveryReportType: 'agent-passport.discovery-report' as const,
    },
    protocols: protocols.sort((a, b) =>
      a.protocol.localeCompare(b.protocol, 'en'),
    ),
    artifacts: sortById(artifacts),
    endpoints: sortById(endpoints),
    identityAssertions: sortById(identities),
    accessAssertions: sortById(access),
    inventoryGroups: sortById(inventoryGroups),
    capabilities: sortById(capabilities),
  };
  const consistency = analyzeConsistency(report, base);
  const complete =
    openapi.complete &&
    webMcpComplete &&
    !report.mcp.candidates.some((candidate) =>
      [candidate.tools, candidate.resources, candidate.prompts].some(
        (inventory) => inventory?.attempted && !inventory.complete,
      ),
    );
  const semanticProjection = passportSemanticProjection({
    ...base,
    consistency,
    fingerprints: {
      passport: {
        algorithm: 'sha256',
        canonicalization: 'RFC8785',
        projectionVersion: PASSPORT_SEMANTIC_PROJECTION_VERSION,
        value: '',
        complete,
      },
    },
  });
  const passport = {
    ...base,
    consistency,
    fingerprints: {
      passport: {
        algorithm: 'sha256' as const,
        canonicalization: 'RFC8785' as const,
        projectionVersion: PASSPORT_SEMANTIC_PROJECTION_VERSION,
        value: canonicalSha256(semanticProjection),
        complete,
      },
    },
  };
  return passportSchema.parse(passport);
}
