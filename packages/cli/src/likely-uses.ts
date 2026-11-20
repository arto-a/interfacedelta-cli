import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CheckResult } from './types';

/** One place a changed name appears in the scanned tree. Never line text. */
export type LikelyUse = {
  /** The search term that matched: a capability name or path segment. */
  term: string;
  /** Repository-relative path with forward slashes. */
  path: string;
  /** 1-based line number of the match. */
  line: number;
};

/** Likely uses for one change, by its semanticId. */
export type ChangeLikelyUses = {
  change: string;
  uses: LikelyUse[];
};

/** Likely uses for one check result, attached as `CheckResult.likelyUses`. */
export type LikelyUsesReport = {
  /** True when the scan stopped at its file or byte cap. */
  truncated: boolean;
  changes: ChangeLikelyUses[];
};

export type LikelyUsesLimits = {
  /** Candidate files read before the scan stops. */
  maxFiles: number;
  /** Bytes read before the scan stops. */
  maxBytes: number;
  /** Locations kept per change. */
  maxPerChange: number;
  /** Locations kept across the whole scan. */
  maxTotal: number;
};

export const DEFAULT_LIKELY_USES_LIMITS: LikelyUsesLimits = {
  maxFiles: 20_000,
  maxBytes: 64 * 1024 * 1024,
  maxPerChange: 20,
  maxTotal: 200,
};

/** Directories never entered; the `.interfacedelta` folder is our own. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'vendor',
  '.next',
  'coverage',
  '.venv',
  '__pycache__',
  '.interfacedelta',
]);
const TEXT_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'go',
  'rb',
  'java',
  'kt',
  'rs',
  'cs',
  'php',
  'swift',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
]);
const TEXT_FILENAMES = new Set(['.mcp.json', 'mcp.json']);
/** Larger files are skipped without reading. */
const MAX_FILE_BYTES = 1024 * 1024;
/** A NUL byte this early means the file is binary. */
const BINARY_SNIFF_BYTES = 8192;
/** Shorter terms (like `acp` or `out`) match too much prose to be useful. */
const MIN_TERM_LENGTH = 4;

const isIdentifierCharacter = (code: number): boolean =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95;

/**
 * Case-sensitive whole-identifier match: neither neighbor may be
 * `[A-Za-z0-9_]`, so `create_pull_request` matches a call site but not
 * `create_pull_request_v2` or `my_create_pull_request`. Any other character
 * (including `-` and `.`) is a boundary.
 */
export function matchesWholeIdentifier(text: string, term: string): boolean {
  if (!term) return false;
  for (
    let at = text.indexOf(term);
    at !== -1;
    at = text.indexOf(term, at + 1)
  ) {
    if (at > 0 && isIdentifierCharacter(text.charCodeAt(at - 1))) continue;
    const after = at + term.length;
    if (after < text.length && isIdentifierCharacter(text.charCodeAt(after)))
      continue;
    return true;
  }
  return false;
}

/** Pointer tokens preserve literal dots and decode escapes in RFC 6901 order. */
const lastPathSegment = (path: string): string => {
  if (path.startsWith('$/'))
    return (path.split('/').at(-1) ?? '')
      .replace(/~1/g, '/')
      .replace(/~0/g, '~');
  const segments = path.split(/[/.]/).filter(Boolean);
  return segments.at(-1) ?? '';
};

type ChangeQueries = { change: string; terms: string[]; uses: LikelyUse[] }[];

/**
 * Terms for each blocked or warned change, in change order: the subject's
 * capability name (endpoint subjects carry a URL, not a name worth searching)
 * and the last segment of the change path. Terms under four characters and
 * duplicates are dropped.
 */
function queriesFor(
  results: readonly CheckResult[],
): (undefined | ChangeQueries)[] {
  return results.map((result) => {
    const queries: ChangeQueries = [];
    result.comparison.changes.forEach((change, index) => {
      const decision = result.decisions[index];
      if (
        !decision ||
        (decision.action !== 'block' && decision.action !== 'warn')
      )
        return;
      const terms: string[] = [];
      const add = (term: string) => {
        if (term.length >= MIN_TERM_LENGTH && !terms.includes(term))
          terms.push(term);
      };
      const subject = result.subjects[change.entityId];
      if (subject && !subject.kind.endsWith('.endpoint')) add(subject.name);
      add(lastPathSegment(change.path));
      if (terms.length)
        queries.push({ change: change.semanticId, terms, uses: [] });
    });
    return queries.length ? queries : undefined;
  });
}

const isTextFile = (name: string): boolean =>
  TEXT_FILENAMES.has(name) ||
  (name.lastIndexOf('.') > 0 &&
    TEXT_EXTENSIONS.has(name.slice(name.lastIndexOf('.') + 1)));

const insideRoot = (root: string, path: string): boolean => {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

/** Recheck every ancestor: O_NOFOLLOW only protects the final path component. */
async function safeDirectory(
  root: string,
  directory: string,
): Promise<boolean> {
  if (!insideRoot(root, directory)) return false;
  const parent = dirname(directory);
  if (directory !== root && !(await safeDirectory(root, parent))) return false;
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const resolved = await realpath(directory);
    return resolved === directory && insideRoot(root, resolved);
  } catch (error) {
    if (isReplacementError(error)) return false;
    throw error;
  }
}

const isReplacementError = (error: unknown): boolean =>
  ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );

/** Depth-first in sorted name order; revalidate directories before descending. */
async function* candidateFiles(
  root: string,
  directory = root,
): AsyncGenerator<string> {
  if (!(await safeDirectory(root, directory))) return;
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  if (!(await safeDirectory(root, directory))) return;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* candidateFiles(root, join(directory, entry.name));
    } else if (entry.isFile() && isTextFile(entry.name))
      yield join(directory, entry.name);
  }
}

/** Reads one candidate; `content` is unset for oversize and binary files. */
async function readCandidate(
  root: string,
  path: string,
  remainingBytes: number,
): Promise<{ read: number; truncated?: boolean; content?: string }> {
  try {
    return await readValidatedCandidate(root, path, remainingBytes);
  } catch (error) {
    if (isReplacementError(error)) return { read: 0 };
    throw error;
  }
}

async function readValidatedCandidate(
  root: string,
  path: string,
  remainingBytes: number,
): Promise<{ read: number; truncated?: boolean; content?: string }> {
  if (!(await safeDirectory(root, dirname(path)))) return { read: 0 };
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) return { read: 0 };
  if ((await realpath(path)) !== path) return { read: 0 };
  // Where O_NOFOLLOW is unavailable, lstat/realpath plus the opened handle's
  // identity provide a best-effort fallback; path resolution is not atomic.
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { read: 0 };
    if (!(await safeDirectory(root, dirname(path)))) return { read: 0 };
    const current = await lstat(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      return { read: 0 };
    const size = opened.size;
    if (size > MAX_FILE_BYTES) return { read: 0 };
    const budget = Math.min(size, remainingBytes);
    const buffer = Buffer.alloc(budget);
    let read = 0;
    while (read < budget) {
      const { bytesRead } = await handle.read(
        buffer,
        read,
        budget - read,
        read,
      );
      if (!bytesRead) break;
      read += bytesRead;
    }
    const truncated = read === budget && (await handle.stat()).size > read;
    if (buffer.subarray(0, Math.min(read, BINARY_SNIFF_BYTES)).includes(0))
      return { read, truncated };
    // A budget cut may split an identifier or a UTF-8 sequence. Only search
    // complete lines when bytes remain unread to avoid inventing a boundary.
    const complete = truncated ? buffer.lastIndexOf(10, read - 1) + 1 : read;
    return {
      read,
      truncated,
      content: buffer.subarray(0, complete).toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

const byPathLineTerm = (a: LikelyUse, b: LikelyUse) =>
  a.path < b.path
    ? -1
    : a.path > b.path
      ? 1
      : a.line - b.line || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0);

/**
 * Searches `root` for likely uses of the names each blocked or warned change
 * touched. One walk serves every result. The returned array lines up with
 * `results`; an entry is undefined when that result had nothing to search,
 * and callers then leave `likelyUses` unset. Hints only: this never changes
 * a decision, and line text never leaves the scanner.
 */
export async function scanLikelyUses(
  root: string,
  results: readonly CheckResult[],
  limits: Partial<LikelyUsesLimits> = {},
): Promise<(LikelyUsesReport | undefined)[]> {
  const { maxFiles, maxBytes, maxPerChange, maxTotal } = {
    ...DEFAULT_LIKELY_USES_LIMITS,
    ...limits,
  };
  const perResult = queriesFor(results);
  const queries = perResult.flatMap((item) => item ?? []);
  if (!queries.length) return results.map(() => undefined);
  const requestedRoot = resolve(root);
  const rootStat = await lstat(requestedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('Likely-uses root must be a directory, not a symlink');
  root = await realpath(requestedRoot);
  const currentRoot = await lstat(requestedRoot);
  const resolvedRoot = await lstat(root);
  if (
    !currentRoot.isDirectory() ||
    currentRoot.isSymbolicLink() ||
    currentRoot.dev !== rootStat.dev ||
    currentRoot.ino !== rootStat.ino ||
    resolvedRoot.dev !== rootStat.dev ||
    resolvedRoot.ino !== rootStat.ino ||
    !(await safeDirectory(root, root))
  )
    throw new Error('Likely-uses root changed during validation');
  let truncated = false;
  let total = 0;
  let filesRead = 0;
  let bytes = 0;
  const files = candidateFiles(root);
  let scanning = true;
  while (scanning) {
    const next = await files.next();
    if (next.done) break;
    // A pending file with a cap already reached means results may be missing.
    if (filesRead >= maxFiles || bytes >= maxBytes) {
      truncated = true;
      break;
    }
    const {
      read,
      content,
      truncated: unread,
    } = await readCandidate(root, next.value, maxBytes - bytes);
    filesRead++;
    bytes += read;
    if (unread) {
      truncated = true;
      scanning = false;
    }
    if (content === undefined) continue;
    const path = relative(root, next.value).split(sep).join('/');
    const lines = content.split('\n');
    for (let index = 0; index < lines.length && total < maxTotal; index++) {
      const line = lines[index]!;
      for (const query of queries) {
        if (total >= maxTotal) break;
        if (query.uses.length >= maxPerChange) continue;
        for (const term of query.terms) {
          if (query.uses.length >= maxPerChange || total >= maxTotal) break;
          if (matchesWholeIdentifier(line, term)) {
            query.uses.push({ term, path, line: index + 1 });
            if (++total >= maxTotal) break;
          }
        }
      }
    }
    if (total >= maxTotal) scanning = false;
  }
  return perResult.map((queriesForOne) =>
    queriesForOne
      ? {
          truncated,
          changes: queriesForOne.map(({ change, uses }) => ({
            change,
            uses: [...uses].sort(byPathLineTerm),
          })),
        }
      : undefined,
  );
}
