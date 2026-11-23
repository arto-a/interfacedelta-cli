import { posix } from 'node:path';
import {
  citationPath,
  citationTarget,
  isToolCitation,
  citationFingerprint,
  parseCitations,
  type ToolCitation,
  type Citation,
} from './citation-format';
import {
  citationCheckoutRoot,
  fetchCitationSource,
  hashCitationFile,
  SOURCE_CONCURRENCY,
} from './citation-source';
import { readCitationFile } from './citation-io';
import { citationObject, verifyCitationAnswer } from './citation-signature';
import { ConfigurationError, InspectionError } from './errors';
import { writeAtomic } from './io';
import { DEFAULT_LIKELY_USES_LIMITS, validateScanRoot } from './likely-uses';
import { sanitizeTerminal } from './sanitize';
import { assertNoSecret } from './secrets';
import { scanSkillFiles, type SkillFileOptions } from './skill-files';
import { checkStatusTools, type StatusEnvironment } from './status';
import { CLI_VERSION } from './types';

export const CITATION_STATUSES = [
  'current',
  'changed',
  'removed',
  'not_observed',
  'malformed',
  'signature_invalid',
  'missing',
  'unreachable',
  'not_checked',
] as const;
export type CitationStatus = (typeof CITATION_STATUSES)[number];
export type CitationResult = {
  path: string;
  line: number;
  status: CitationStatus;
  citation?: Citation;
  currentSha256?: string;
  reason?: string;
  currentFingerprint?: string;
  changeClass?: string;
  changedAt?: string;
  signature?: 'valid' | 'invalid';
};
export type CitationsReport = {
  formatVersion: 'interfacedelta-citations-v1';
  truncated: boolean;
  filesRead: number;
  bytesRead: number;
  toolsChecked: number;
  citations: CitationResult[];
};
export type CitationsOptions = SkillFileOptions & {
  dir?: string;
  apiUrl?: string;
  fetch?: boolean;
  /** Explicit trusted published keys file, relative to the scan root. */
  keys?: string;
  json?: boolean;
  sarif?: string;
  failOn?: string;
};
const FAILURES = [
  'changed',
  'removed',
  'malformed',
  'signature_invalid',
  'missing',
  'unreachable',
  'not_checked',
] as const;
export function citationsFailOn(value?: string): CitationStatus[] {
  if (value === undefined) return [];
  const items = value.split(',').map((item) => item.trim());
  if (items.some((item) => !(FAILURES as readonly string[]).includes(item)))
    throw new ConfigurationError(
      `--fail-on must list: ${FAILURES.join(', ')}.`,
    );
  return [...new Set(items)] as CitationStatus[];
}
const sourceStatuses: readonly string[] = [
  'missing',
  'unreachable',
  'not_checked',
];
const hasSourceResults = (report: CitationsReport): boolean =>
  report.citations.some(
    (item) =>
      (item.citation && !isToolCitation(item.citation)) ||
      sourceStatuses.includes(item.status),
  );
const citationName = (citation: Citation): string =>
  isToolCitation(citation) ? citation.tool : (citation.label ?? citation.kind);
const identity = (citation: ToolCitation) =>
  JSON.stringify([new URL(citation.endpoint).href, citation.tool]);

export function formatCitations(report: CitationsReport): string {
  return (
    [
      hasSourceResults(report)
        ? 'Location | Source | Target | Status | Change class | Change date'
        : 'Location | Tool | Endpoint | Status | Change class | Change date',
      ...report.citations.map((item) =>
        [
          `${item.path}:${item.line}`,
          item.citation ? citationName(item.citation) : '',
          item.citation ? citationTarget(item.citation) : '',
          item.status + (item.reason ? ` (${item.reason})` : ''),
          item.changeClass ?? '',
          item.changedAt ?? '',
        ]
          .map((value) => sanitizeTerminal(value))
          .join(' | ')
          .trimEnd(),
      ),
      `${report.citations.length} citations; ${report.toolsChecked} tools checked; ${report.filesRead} files read.${report.truncated ? ' Truncated: some citations may be missing.' : ''}`,
      hasSourceResults(report)
        ? 'A matching pin describes source bytes or a stored tool definition, not proof that instructions are correct or sources are trustworthy.'
        : 'A matching fingerprint describes the stored record, not proof that instructions are correct or observations are fresh.',
    ].join('\n') + '\n'
  );
}

export function citationsToSarif(report: CitationsReport) {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        automationDetails: { id: 'interfacedelta-citations/' },
        tool: {
          driver: {
            name: 'InterfaceDelta citations',
            version: CLI_VERSION,
            rules: CITATION_STATUSES.filter(
              (id) =>
                id !== 'current' &&
                (!sourceStatuses.includes(id) || hasSourceResults(report)),
            ).map((id) => ({ id, shortDescription: { text: id } })),
          },
        },
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: report.truncated
              ? [
                  {
                    level: 'warning',
                    message: {
                      text: 'Citations scan truncated; some citations may be missing.',
                    },
                  },
                ]
              : [],
          },
        ],
        results: report.citations
          .filter((item) => item.status !== 'current')
          .map((item) => {
            if (!citationPath(item.path))
              throw new ConfigurationError(
                'SARIF citation locations must be clean root-relative paths.',
              );
            return {
              ruleId: item.status,
              level:
                item.status === 'not_observed' || item.status === 'not_checked'
                  ? 'note'
                  : 'warning',
              message: {
                text: sanitizeTerminal(
                  `${item.status}${item.reason ? ` (${item.reason})` : ''}${item.citation ? `: ${citationName(item.citation)} at ${citationTarget(item.citation)}` : ''}${item.changeClass ? ` (${item.changeClass}, ${item.changedAt})` : ''}`,
                ),
              },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: {
                      uri: item.path
                        .split('/')
                        .map(encodeURIComponent)
                        .join('/'),
                    },
                    region: { startLine: item.line },
                  },
                },
              ],
            };
          }),
      },
    ],
  };
}

export async function runCitations(
  args: CitationsOptions,
  env: StatusEnvironment,
) {
  const failOn = citationsFailOn(args.failOn);
  if (args.keys && !citationPath(args.keys))
    throw new ConfigurationError('--keys must be relative to the scan root.');
  let root: string;
  try {
    root = await validateScanRoot(args.dir ?? '.');
  } catch {
    throw new ConfigurationError(
      'Citations directory must be a readable directory, not a symlink.',
    );
  }
  const citations: CitationResult[] = [];
  const maxTotal = args.limits?.maxTotal ?? DEFAULT_LIKELY_USES_LIMITS.maxTotal;
  const scan = await scanSkillFiles(root, args, (path, content) => {
    for (const item of parseCitations(content)) {
      if (citations.length >= maxTotal) return false;
      citations.push({
        path,
        line: item.line,
        status: item.citation ? 'not_observed' : 'malformed',
        ...(item.citation ? { citation: item.citation } : {}),
      });
    }
  });
  const pending = new Map<string, ToolCitation>();
  const localJson = new Map<string, Promise<unknown>>();
  const readJson = (path: string) => {
    let value = localJson.get(path);
    if (!value) {
      value = readCitationFile(root, path).then(
        (raw) => JSON.parse(raw) as unknown,
      );
      localJson.set(path, value);
    }
    return value;
  };
  for (const item of citations) {
    const citation = item.citation;
    if (!citation || !isToolCitation(citation)) continue;
    if (citation.answer) {
      try {
        // Answer paths are relative to the instruction file, not the shell cwd.
        const path = posix.join(posix.dirname(item.path), citation.answer);
        const answer = citationObject(await readJson(path));
        const keys = await readJson(
          args.keys ?? posix.join(posix.dirname(path), 'keys.json'),
        );
        const endpoint = citationObject(answer.service).endpoint;
        if (
          !verifyCitationAnswer(answer, keys) ||
          answer.status !== 'observed' ||
          endpoint !== new URL(citation.endpoint).href ||
          citationObject(answer.tool).name !== citation.tool ||
          citationFingerprint(citationObject(answer.change).fingerprint) !==
            citation.fingerprint.toLowerCase()
        )
          throw new Error();
        item.signature = 'valid';
      } catch {
        item.signature = 'invalid';
        item.status = 'signature_invalid';
        continue;
      }
    }
    pending.set(identity(citation), citation);
  }
  if (pending.size) {
    const tools = [...pending.values()].map(({ endpoint, tool }) => ({
      endpoint: new URL(endpoint).href,
      tool,
      sinceTime: '1970-01-01T00:00:00Z',
    }));
    const response = await checkStatusTools(tools, args, env);
    response.checkedTools.forEach((answer, index) => {
      const input = tools[index]!;
      if (
        answer.status === 'observed' &&
        (answer.service?.endpoint !== input.endpoint ||
          answer.tool?.name !== input.tool ||
          !citationFingerprint(answer.change?.fingerprint))
      )
        throw new InspectionError(
          'The record returned an incomplete or mismatched citation answer.',
        );
      for (const item of citations) {
        if (
          !item.citation ||
          !isToolCitation(item.citation) ||
          item.status === 'signature_invalid' ||
          identity(item.citation) !==
            JSON.stringify([input.endpoint, input.tool])
        )
          continue;
        if (answer.status === 'removed') item.status = 'removed';
        else if (answer.status !== 'observed') item.status = 'not_observed';
        else {
          const fingerprint = citationFingerprint(answer.change!.fingerprint)!;
          item.currentFingerprint = fingerprint;
          item.status =
            fingerprint.toLowerCase() ===
            item.citation.fingerprint.toLowerCase()
              ? 'current'
              : 'changed';
          if (item.status === 'changed' && answer.change!.last) {
            item.changeClass = answer.change!.last.class;
            item.changedAt = answer.change!.last.at;
          }
        }
      }
    });
  }
  const sourceRoot = await citationCheckoutRoot(root);
  const sources = citations.filter(
    (item) => item.citation && !isToolCitation(item.citation),
  );
  let nextSource = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(SOURCE_CONCURRENCY, sources.length) },
      async () => {
        while (nextSource < sources.length) {
          const item = sources[nextSource++]!;
          const citation = item.citation!;
          if (isToolCitation(citation)) continue;
          if (
            citation.kind === 'git' ||
            (citation.kind === 'url' && !args.fetch)
          ) {
            item.status = 'not_checked';
            continue;
          }
          const result =
            citation.kind === 'file'
              ? await hashCitationFile(sourceRoot, citation.path)
              : await fetchCitationSource(citation.uri, env);
          item.status = result.status;
          if (result.status !== 'current' && result.reason)
            item.reason = result.reason;
          if (result.status === 'current') {
            item.currentSha256 = result.sha256;
            item.status =
              result.sha256 === citation.sha256.toLowerCase()
                ? 'current'
                : 'changed';
          }
        }
      },
    ),
  );
  const report: CitationsReport = {
    formatVersion: 'interfacedelta-citations-v1',
    truncated: scan.truncated,
    filesRead: scan.filesRead,
    bytesRead: scan.bytesRead,
    toolsChecked: pending.size,
    citations,
  };
  const output = args.json
    ? JSON.stringify(report, null, 2) + '\n'
    : formatCitations(report);
  assertNoSecret(output, 'citations output');
  if (args.sarif)
    await writeAtomic(
      args.sarif,
      JSON.stringify(citationsToSarif(report), null, 2) + '\n',
      true,
    );
  return {
    report,
    output,
    exitCode: citations.some((item) => failOn.includes(item.status)) ? 1 : 0,
  };
}
