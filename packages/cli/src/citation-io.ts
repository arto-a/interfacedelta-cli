import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { citationPath } from './citation-format';
import { ConfigurationError } from './errors';
import { readCandidate } from './likely-uses';

/** Reject symlinks and traversal at every existing component, including output parents. */
export async function citationLocalPath(
  root: string,
  path: string,
  create = false,
): Promise<string> {
  if (!citationPath(path))
    throw new ConfigurationError(
      'Citation paths must be contained relative paths.',
    );
  const parts = path.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (create && i < parts.length - 1) {
        await mkdir(current).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        info = await lstat(current);
      }
    }
    if (
      info &&
      (info.isSymbolicLink() ||
        (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()))
    )
      throw new ConfigurationError(
        'Citation paths must not contain symlinks or special files.',
      );
  }
  return current;
}
export async function readCitationFile(
  root: string,
  path: string,
): Promise<string> {
  const target = await citationLocalPath(root, path);
  const result = await readCandidate(root, target, 1024 * 1024);
  if (result.content === undefined || result.truncated)
    throw new ConfigurationError(
      'Citation file must be readable text of at most 1 MiB.',
    );
  return result.content;
}
