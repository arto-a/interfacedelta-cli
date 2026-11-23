import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { canonicalJson } from '@interfacedelta/core';
import {
  citationEndpoint,
  citationUri,
  citationFingerprint,
  formatCitation,
  insertCitation,
  validCitation,
  type ToolCitation,
  type SourceCitation,
  type Citation,
} from './citation-format';
import {
  citationCheckoutRoot,
  fetchCitationSource,
  hashCitationFile,
  parseGitSource,
} from './citation-source';
import { citationLocalPath, readCitationFile } from './citation-io';
import {
  citationObject,
  CITATION_KEYS,
  verifyCitationAnswer,
  mergeCitationKeys,
} from './citation-signature';
import { ConfigurationError, InspectionError } from './errors';
import { writeAtomic } from './io';
import { validateScanRoot } from './likely-uses';
import { assertNoSecret } from './secrets';
import { checkStatusTools, type StatusEnvironment } from './status';

export type CiteOptions = {
  endpoint?: string;
  tool?: string;
  fileSource?: string;
  url?: string;
  git?: string;
  file?: string;
  apiUrl?: string;
};
/** Use only InterfaceDelta's public keys endpoint, never a URL supplied by an answer. */
async function fetchKeys(
  env: StatusEnvironment,
  apiUrl?: string,
): Promise<unknown> {
  try {
    const response = await env.fetch(
      new URL(
        '/api/v1/record/check/keys',
        apiUrl ?? 'https://interfacedelta.com',
      ),
      {
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InspectionError('Published Record Check keys are unavailable.');
  }
}

async function runToolCite(
  args: CiteOptions & { endpoint: string; tool: string },
  env: StatusEnvironment,
  now = new Date(),
) {
  const checked = now.toISOString().slice(0, 10);
  if (
    !citationEndpoint(args.endpoint) ||
    !validCitation({
      endpoint: args.endpoint,
      tool: args.tool,
      fingerprint: 'sha256:' + '0'.repeat(64),
      checked,
    })
  )
    throw new ConfigurationError(
      'cite needs an HTTPS endpoint without credentials, query or fragment, and a tool name of 1–128 printable characters.',
    );
  const file = args.file ? resolve(args.file) : undefined;
  const root = await validateScanRoot(file ? dirname(file) : '.');
  // Read before spending a record request, and refuse ambiguous malformed updates.
  const content = file
    ? await readCitationFile(root, basename(file))
    : undefined;
  if (content !== undefined) {
    try {
      insertCitation(content, {
        endpoint: args.endpoint,
        tool: args.tool,
        fingerprint: 'sha256:' + '0'.repeat(64),
        checked,
      });
    } catch {
      throw new ConfigurationError(
        'Repair malformed citations before updating this file.',
      );
    }
  }
  const result = await checkStatusTools(
    [
      {
        endpoint: args.endpoint,
        tool: args.tool,
        sinceTime: '1970-01-01T00:00:00Z',
      },
    ],
    args,
    env,
  );
  const { changedSinceTime: _unsigned, ...answer } = result.checkedTools[0]!;
  void _unsigned;
  const change = citationObject(answer.change);
  if (
    answer.status !== 'observed' ||
    answer.service?.endpoint !== new URL(args.endpoint).href ||
    answer.tool?.name !== args.tool ||
    typeof change.fingerprint !== 'string'
  )
    throw new InspectionError(
      'The record has no observed fingerprint for this endpoint and tool.',
    );
  const citation: ToolCitation = {
    endpoint: args.endpoint,
    tool: args.tool,
    fingerprint: citationFingerprint(change.fingerprint) ?? '',
    checked,
  };
  if (!validCitation(citation))
    throw new InspectionError('The record returned an invalid fingerprint.');
  const keys = await fetchKeys(env, args.apiUrl);
  if (!verifyCitationAnswer(answer, keys))
    throw new InspectionError('The current Record Check signature is invalid.');
  const raw = canonicalJson(answer) + '\n';
  assertNoSecret(raw, 'stored citation answer');
  const hash = createHash('sha256').update(raw).digest('hex');
  citation.answer = `.interfacedelta/citations/${hash}.json`;
  const output = formatCitation(citation) + '\n';
  assertNoSecret(output, 'citation');
  const next =
    content === undefined ? undefined : insertCitation(content, citation);
  const keysPath = await citationLocalPath(root, CITATION_KEYS, true);
  let existingKeys: unknown = { keys: [] };
  try {
    await lstat(keysPath);
    existingKeys = JSON.parse(await readCitationFile(root, CITATION_KEYS));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const mergedKeys = mergeCitationKeys(existingKeys, keys);
  await writeAtomic(keysPath, JSON.stringify(mergedKeys, null, 2) + '\n', true);
  await writeAtomic(
    await citationLocalPath(root, citation.answer, true),
    raw,
    true,
  );
  if (file && next !== content)
    await writeAtomic(
      await citationLocalPath(root, basename(file)),
      next!,
      true,
    );
  return { citation, output };
}

/** Source writers share insertion rules but never store fetched contents. */
export function runCite(
  args: CiteOptions & { endpoint: string; tool: string },
  env: StatusEnvironment,
  now?: Date,
): ReturnType<typeof runToolCite>;
export function runCite(
  args: CiteOptions,
  env: StatusEnvironment,
  now?: Date,
): Promise<{ citation: Citation; output: string }>;
export async function runCite(
  args: CiteOptions,
  env: StatusEnvironment,
  now = new Date(),
) {
  const sources = [args.fileSource, args.url, args.git].filter(
    (value) => value !== undefined,
  );
  if (!sources.length) {
    if (args.endpoint === undefined || args.tool === undefined)
      throw new ConfigurationError(
        'cite requires an endpoint and a tool name.',
      );
    return runToolCite(
      { ...args, endpoint: args.endpoint, tool: args.tool },
      env,
      now,
    );
  }
  if (
    sources.length !== 1 ||
    args.endpoint !== undefined ||
    args.tool !== undefined
  )
    throw new ConfigurationError('Choose exactly one citation source.');
  const checked = now.toISOString().slice(0, 10);
  let citation: SourceCitation;
  if (args.fileSource !== undefined)
    citation = {
      kind: 'file',
      path: args.fileSource,
      sha256: '0'.repeat(64),
      checked,
    };
  else if (args.url !== undefined)
    citation = { kind: 'url', uri: args.url, sha256: '0'.repeat(64), checked };
  else citation = { ...parseGitSource(args.git!), checked };
  if (
    !validCitation(citation) ||
    (args.url !== undefined && !citationUri(args.url))
  )
    throw new ConfigurationError(
      'Invalid citation source: use a contained path or an HTTPS URL without credentials.',
    );
  const file = args.file ? resolve(args.file) : undefined;
  const outputRoot = await validateScanRoot(file ? dirname(file) : '.');
  const sourceRoot = await citationCheckoutRoot(await validateScanRoot('.'));
  const content = file
    ? await readCitationFile(outputRoot, basename(file))
    : undefined;
  // Refuse malformed instruction files before a network request or any write.
  if (content !== undefined) {
    try {
      insertCitation(content, citation);
    } catch {
      throw new ConfigurationError(
        'Repair malformed citations before updating this file.',
      );
    }
  }
  if (citation.kind !== 'git') {
    const result =
      citation.kind === 'file'
        ? await hashCitationFile(sourceRoot, citation.path)
        : await fetchCitationSource(citation.uri, env);
    if (result.status !== 'current')
      throw new InspectionError(
        `Citation source is ${result.status}${result.reason ? ` (${result.reason})` : ''}.`,
      );
    citation.sha256 = result.sha256;
  }
  const output = formatCitation(citation) + '\n';
  assertNoSecret(output, 'citation');
  if (file && content !== undefined) {
    const next = insertCitation(content, citation);
    if (next !== content)
      await writeAtomic(
        await citationLocalPath(outputRoot, basename(file)),
        next,
        true,
      );
  }
  return { citation, output };
}
