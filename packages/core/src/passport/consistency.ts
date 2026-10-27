import type {
  AgentPassport,
  ConsistencyFinding,
  DiscoveryReport,
  McpCandidateResult,
  OpenApiSchemaSlot,
} from '@interfacedelta/contracts';
import { analyzeSchemaCompatibility } from '@interfacedelta/schema-compatibility';
import { canonicalUrl } from './canonical-json';

const finding = (
  code: string,
  status: ConsistencyFinding['status'],
  subjectRefs: string[],
  evidenceRefs: string[],
  message: string,
): ConsistencyFinding => ({
  code,
  status,
  subjectRefs: [...subjectRefs].sort(),
  evidenceRefs: [...evidenceRefs].sort(),
  message,
});
const endpointStatus = (
  candidate: McpCandidateResult,
): ConsistencyFinding['status'] =>
  candidate.status === 'valid' || candidate.status === 'truncated'
    ? 'match'
    : candidate.status === 'not_mcp'
      ? 'mismatch'
      : 'indeterminate';

function equivalence(
  left: unknown,
  right: unknown,
): ConsistencyFinding['status'] {
  if (left === undefined || right === undefined) return 'indeterminate';
  const forward = analyzeSchemaCompatibility({
    previousSchema: left,
    currentSchema: right,
    direction: 'input',
  });
  const reverse = analyzeSchemaCompatibility({
    previousSchema: right,
    currentSchema: left,
    direction: 'input',
  });
  if (forward.status === 'indeterminate' || reverse.status === 'indeterminate')
    return 'indeterminate';
  if (forward.status === 'breaking' || reverse.status === 'breaking')
    return 'mismatch';
  return 'match';
}
const schemaSlot = (
  slots: readonly OpenApiSchemaSlot[] | undefined,
  mediaType: string | undefined,
) => slots?.find((item) => item.mediaType === mediaType);

export function analyzeConsistency(
  report: DiscoveryReport,
  passport: Pick<AgentPassport, 'artifacts' | 'endpoints' | 'capabilities'>,
): AgentPassport['consistency'] {
  const findings: ConsistencyFinding[] = [];
  if (report.ard.status === 'valid')
    for (const declaration of report.ard.summary?.declarations ?? []) {
      if (
        declaration.type === 'application/a2a-agent-card+json' &&
        declaration.url
      ) {
        const artifact = passport.artifacts.find(
          (item) => item.kind === 'a2a.agent-card',
        );
        const exact =
          artifact &&
          canonicalUrl(declaration.url) === canonicalUrl(artifact.url);
        let status: ConsistencyFinding['status'] = 'indeterminate';
        if (exact)
          status =
            report.a2a.status === 'valid'
              ? 'match'
              : report.a2a.status === 'not_found' ||
                  report.a2a.status === 'invalid'
                ? 'mismatch'
                : 'indeterminate';
        findings.push(
          finding(
            'ARD_DECLARED_A2A_ARTIFACT',
            status,
            artifact ? [artifact.id] : [],
            ['discovery:ard', 'discovery:a2a'],
            exact
              ? `ARD declaration and A2A observation refer to ${artifact!.url}.`
              : 'ARD declaration was not the fixed A2A artifact observed by this inspection.',
          ),
        );
      }
    }
  for (const card of report.mcp.serverCards) {
    const artifact = passport.artifacts.find(
      (item) =>
        item.kind === 'mcp.server-card.experimental' &&
        canonicalUrl(item.url) === canonicalUrl(card.serverCardUrl),
    );
    const status: ConsistencyFinding['status'] =
      card.status === 'valid'
        ? 'match'
        : card.status === 'invalid' ||
            card.status === 'malformed_json' ||
            card.status === 'not_found'
          ? 'mismatch'
          : 'indeterminate';
    findings.push(
      finding(
        'ARD_DECLARED_MCP_SERVER_CARD',
        status,
        artifact ? [artifact.id] : [],
        ['discovery:ard', `server-card:${canonicalUrl(card.serverCardUrl)}`],
        status === 'match'
          ? 'ARD-declared experimental Server Card was schema-valid.'
          : status === 'mismatch'
            ? `Declared Server Card observation was ${card.status}.`
            : `Declared Server Card could not be conclusively validated (${card.status}).`,
      ),
    );
    for (const remote of card.remotes.filter(
      (item) => item.transport === 'streamable-http',
    )) {
      const candidate = report.mcp.candidates.find(
        (item) =>
          canonicalUrl(item.endpoint) === canonicalUrl(remote.remoteEndpoint) &&
          item.serverCardUrl &&
          canonicalUrl(item.serverCardUrl) === canonicalUrl(card.serverCardUrl),
      );
      const endpoint = passport.endpoints.find(
        (item) =>
          item.protocol === 'mcp' &&
          canonicalUrl(item.url) === canonicalUrl(remote.remoteEndpoint),
      );
      let result: ConsistencyFinding['status'];
      if (!remote.concrete || remote.probePolicy === 'configuration_required')
        result = 'indeterminate';
      else if (!candidate || candidate.probePolicy !== 'inspected')
        result = 'indeterminate';
      else result = endpointStatus(candidate);
      findings.push(
        finding(
          'MCP_SERVER_CARD_REMOTE_OBSERVED',
          result,
          endpoint ? [endpoint.id] : [],
          [artifact?.id ?? `server-card:${canonicalUrl(card.serverCardUrl)}`],
          result === 'match'
            ? 'The concrete declared remote and recognized live MCP observation use the same canonical URL.'
            : result === 'mismatch'
              ? 'The declared remote was probed and deterministically classified as not MCP.'
              : 'The declared remote was not conclusively observed as MCP.',
        ),
      );
    }
  }
  for (const candidate of report.mcp.candidates.filter((item) => item.protocol))
    for (const [name, inventory] of [
      ['tools', candidate.tools],
      ['resources', candidate.resources],
      ['prompts', candidate.prompts],
    ] as const) {
      const advertised = candidate.capabilities?.[name] === true;
      let status: ConsistencyFinding['status'] = 'not_applicable';
      if (advertised && inventory)
        status = inventory.complete
          ? 'match'
          : inventory.failureCode === 'JSON_RPC_ERROR' &&
              inventory.failureRpcCode === -32601
            ? 'mismatch'
            : 'indeterminate';
      const endpoint = passport.endpoints.find(
        (item) => canonicalUrl(item.url) === canonicalUrl(candidate.endpoint),
      );
      findings.push(
        finding(
          `MCP_${name.toUpperCase()}_ADVERTISEMENT_LIST`,
          status,
          endpoint ? [endpoint.id] : [],
          [`mcp-inventory:${canonicalUrl(candidate.endpoint)}:${name}`],
          status === 'match'
            ? `MCP advertised ${name} and the passive list completed.`
            : status === 'mismatch'
              ? `MCP advertised ${name}, but its list method returned method not found.`
              : status === 'indeterminate'
                ? `MCP advertised ${name}, but listing was inconclusive or truncated.`
                : `MCP did not advertise ${name}; no comparison applies.`,
        ),
      );
    }

  const openapi = report.openapi;
  for (const document of openapi?.documents ?? []) {
    const artifact = passport.artifacts.find(
      (item) =>
        item.kind === 'openapi.document' &&
        canonicalUrl(item.url) === canonicalUrl(document.artifactUrl),
    );
    const artifactStatus: ConsistencyFinding['status'] =
      document.status === 'valid'
        ? 'match'
        : document.status === 'invalid' ||
            document.status === 'malformed' ||
            document.status === 'not_found'
          ? 'mismatch'
          : 'indeterminate';
    findings.push(
      finding(
        'ARD_OPENAPI_ARTIFACT_OBSERVED',
        artifactStatus,
        artifact ? [artifact.id] : [],
        ['discovery:ard', document.declarationId],
        artifactStatus === 'match'
          ? `The ARD-declared artifact was observed and validated as OpenAPI ${document.openapiVersion}.`
          : artifactStatus === 'mismatch'
            ? `The exact ARD-declared artifact was conclusively ${document.status}.`
            : `The ARD-declared artifact could not be conclusively validated (${document.status}).`,
      ),
    );
    const concrete = document.servers.filter((item) => item.concrete);
    const unresolved = document.servers.some((item) => !item.concrete);
    const serverStatus: ConsistencyFinding['status'] = concrete.some(
      (item) => item.resolvedOrigin === report.origin,
    )
      ? 'match'
      : unresolved || concrete.length === 0
        ? 'indeterminate'
        : 'mismatch';
    findings.push(
      finding(
        'OPENAPI_SERVER_SUBJECT_ALIGNMENT',
        serverStatus,
        artifact ? [artifact.id] : [],
        concrete.map((item) => item.url),
        serverStatus === 'match'
          ? 'A concrete OpenAPI server declaration resolves to the inspected subject origin.'
          : serverStatus === 'mismatch'
            ? 'All concrete OpenAPI server declarations identify different origins.'
            : 'Server-origin alignment cannot be proven from the declared server metadata.',
      ),
    );
  }

  const operations = (openapi?.documents ?? []).flatMap((document) =>
    document.operations.map((operation) => ({ document, operation })),
  );
  const tools = report.mcp.candidates.flatMap((candidate) =>
    (candidate.tools?.items ?? []).map((tool) => ({ candidate, tool })),
  );
  const mappedOperations = operations.filter(
    (item) => item.operation.explicitCapability?.id,
  );
  const mappedTools = tools.filter((item) => item.tool.explicitCapabilityId);
  if (mappedOperations.length === 0 && mappedTools.length === 0)
    findings.push(
      finding(
        'OPENAPI_MCP_EXPLICIT_MAPPING',
        'not_applicable',
        [],
        [],
        'No explicit publisher-provided OpenAPI to MCP correspondence evidence was observed.',
      ),
    );
  const ids = [
    ...new Set([
      ...mappedOperations.map((item) => item.operation.explicitCapability!.id),
      ...mappedTools.map((item) => item.tool.explicitCapabilityId!),
    ]),
  ].sort();
  for (const id of ids) {
    const left = mappedOperations.filter(
      (item) => item.operation.explicitCapability!.id === id,
    );
    const right = mappedTools.filter(
      (item) => item.tool.explicitCapabilityId === id,
    );
    const duplicate = left.length > 1 || right.length > 1;
    const mappingStatus: ConsistencyFinding['status'] =
      duplicate || left.length === 0 || right.length === 0
        ? 'mismatch'
        : 'match';
    findings.push(
      finding(
        'OPENAPI_MCP_EXPLICIT_MAPPING',
        mappingStatus,
        [
          ...left.map((item) => item.operation.key),
          ...right.map((item) => item.tool.name),
        ],
        [id],
        mappingStatus === 'match'
          ? 'OpenAPI and MCP carry the same valid explicit publisher-provided capability identifier.'
          : 'The explicit capability identifier is missing on one surface or is duplicated.',
      ),
    );
    if (mappingStatus !== 'match') continue;
    const operation = left[0]!.operation;
    const tool = right[0]!.tool;
    const mapping = operation.explicitCapability!;
    const input = schemaSlot(
      operation.requestBody?.content,
      mapping.requestMediaType,
    );
    const inputStatus = mapping.requestMediaType
      ? equivalence(input?.schemaCompatibility, tool.inputSchemaCompatibility)
      : 'not_applicable';
    findings.push(
      finding(
        'OPENAPI_MCP_INPUT_SCHEMA_ALIGNMENT',
        inputStatus,
        [operation.key, tool.name],
        [id, mapping.requestMediaType ?? 'no-request-slot'],
        inputStatus === 'match'
          ? 'The explicitly mapped declared input schemas are equivalent within the supported deterministic fragment.'
          : inputStatus === 'mismatch'
            ? 'The explicitly mapped declared input schemas have a proven contradiction.'
            : inputStatus === 'indeterminate'
              ? 'Input equivalence could not be proven within the supported fragment.'
              : 'The explicit mapping did not identify an OpenAPI request schema slot.',
      ),
    );
    const response = operation.responses.find(
      (item) => item.statusKey === mapping.responseStatus,
    );
    const output = schemaSlot(response?.content, mapping.responseMediaType);
    const outputStatus =
      mapping.responseStatus && mapping.responseMediaType
        ? equivalence(
            output?.schemaCompatibility,
            tool.outputSchemaCompatibility,
          )
        : 'not_applicable';
    findings.push(
      finding(
        'OPENAPI_MCP_OUTPUT_SCHEMA_ALIGNMENT',
        outputStatus,
        [operation.key, tool.name],
        [
          id,
          mapping.responseStatus ?? 'no-response-slot',
          mapping.responseMediaType ?? 'no-response-media',
        ],
        outputStatus === 'match'
          ? 'The explicitly mapped declared output schemas are equivalent within the supported deterministic fragment.'
          : outputStatus === 'mismatch'
            ? 'The explicitly mapped declared output schemas have a proven contradiction.'
            : outputStatus === 'indeterminate'
              ? 'Output equivalence could not be proven within the supported fragment.'
              : 'The explicit mapping did not identify an OpenAPI response schema slot.',
      ),
    );
  }

  findings.sort((a, b) =>
    `${a.code}\0${a.subjectRefs.join()}`.localeCompare(
      `${b.code}\0${b.subjectRefs.join()}`,
      'en',
    ),
  );
  const count = (status: ConsistencyFinding['status']) =>
    findings.filter((item) => item.status === status).length;
  return {
    summary: {
      checks: findings.length,
      matches: count('match'),
      mismatches: count('mismatch'),
      indeterminate: count('indeterminate'),
      notApplicable: count('not_applicable'),
    },
    findings,
  };
}
