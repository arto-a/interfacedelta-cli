import { basename, relative, sep } from 'node:path';
import { ConfigurationError } from './errors';
import {
  candidateFiles,
  DEFAULT_LIKELY_USES_LIMITS,
  readCandidate,
  validateScanRoot,
  type LikelyUsesLimits,
} from './likely-uses';

export type SkillFileOptions = {
  /** Additional root-relative globs: *, ** and ?; repeatable on the CLI. */
  include?: string[];
  limits?: Partial<LikelyUsesLimits>;
};
export type SkillFilesReport = {
  files: string[];
  filesRead: number;
  bytesRead: number;
  truncated: boolean;
};

/** Deliberately small glob grammar; never executes patterns or follows paths. */
function glob(pattern: string): (path: string) => boolean {
  pattern = pattern.replace(/^\.\//, '');
  if (
    !pattern ||
    pattern.length > 512 ||
    pattern.startsWith('/') ||
    pattern.split('/').includes('..') ||
    /[\\[\]{}()!]/.test(pattern)
  )
    throw new ConfigurationError(
      '--include needs a root-relative glob using *, ** or ?.',
    );
  const parts = pattern.split('/');
  // Wildcard matching uses bounded dynamic programming, avoiding regex
  // backtracking on untrusted --include patterns and long file names.
  const segment = (name: string, query: string): boolean => {
    let previous = Array<boolean>(name.length + 1).fill(false);
    previous[0] = true;
    for (const token of query) {
      const current = Array<boolean>(name.length + 1).fill(false);
      current[0] = token === '*' && previous[0]!;
      for (let i = 1; i <= name.length; i++)
        current[i] =
          token === '*'
            ? previous[i]! || current[i - 1]!
            : previous[i - 1]! && (token === '?' || token === name[i - 1]);
      previous = current;
    }
    return previous[name.length]!;
  };
  return (path) => {
    const names = path.split('/');
    let previous = Array<boolean>(names.length + 1).fill(false);
    previous[0] = true;
    for (const part of parts) {
      const current = Array<boolean>(names.length + 1).fill(false);
      current[0] = part === '**' && previous[0]!;
      for (let i = 1; i <= names.length; i++)
        current[i] =
          part === '**'
            ? previous[i]! || current[i - 1]!
            : previous[i - 1]! && segment(names[i - 1]!, part);
      previous = current;
    }
    return previous[names.length]!;
  };
}

export function skillFileMatcher(
  include: string[] = [],
): (path: string) => boolean {
  const additions = include.map(glob);
  const names = new Set(['SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
  return (path) =>
    names.has(basename(path)) ||
    /(?:^|\/)\.cursor\/rules\//.test(path) ||
    /(?:^|\/)\.github\/copilot-instructions\.md$/.test(path) ||
    /(?:^|\/)\.claude\/skills\//.test(path) ||
    /(?:^|\/)prompts\/(?:.*\/)?[^/]+\.md$/.test(path) ||
    additions.some((pattern) => pattern(path));
}

/**
 * Same walker, exclusions, root checks and read caps as likely-uses. Contents
 * are only passed to a local visitor, never included in the returned report.
 * Returning false from the visitor stops the scan and marks it truncated.
 */
export async function scanSkillFiles(
  root: string,
  options: SkillFileOptions = {},
  visit?: (path: string, content: string) => void | boolean,
): Promise<SkillFilesReport> {
  const accept = skillFileMatcher(options.include);
  const limits = { ...DEFAULT_LIKELY_USES_LIMITS, ...options.limits };
  root = await validateScanRoot(root);
  const report: SkillFilesReport = {
    files: [],
    filesRead: 0,
    bytesRead: 0,
    truncated: false,
  };
  for await (const path of candidateFiles(root, root, accept)) {
    if (
      report.filesRead >= limits.maxFiles ||
      report.bytesRead >= limits.maxBytes
    ) {
      report.truncated = true;
      break;
    }
    const result = await readCandidate(
      root,
      path,
      limits.maxBytes - report.bytesRead,
    );
    report.filesRead++;
    report.bytesRead += result.read;
    report.truncated ||= result.truncated ?? false;
    if (result.content !== undefined) {
      // candidateFiles has already validated containment.
      const relativePath = relative(root, path).split(sep).join('/');
      report.files.push(relativePath);
      if (visit?.(relativePath, result.content) === false)
        report.truncated = true;
    }
    if (report.truncated) break;
  }
  return report;
}

/** Reusable deterministic finder; no file contents in its public result. */
export async function findSkillFiles(
  root = '.',
  options: SkillFileOptions = {},
): Promise<SkillFilesReport> {
  return scanSkillFiles(root, options);
}
