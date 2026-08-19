import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ConfigurationError } from './errors';

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  } catch (error) {
    throw new ConfigurationError(
      error instanceof SyntaxError
        ? 'Baseline is not valid JSON.'
        : 'Baseline file could not be read.',
    );
  }
}

export async function writeAtomic(
  path: string,
  contents: string,
  force = false,
): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  if (!force) {
    try {
      await stat(destination);
      throw new ConfigurationError(
        `Output file already exists: ${destination}. Use --force to replace it.`,
      );
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new ConfigurationError('Output path could not be checked.');
    }
  }
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('Output file could not be written atomically.');
  }
}
