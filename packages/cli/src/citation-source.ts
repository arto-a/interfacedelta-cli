import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import {
  citationNetwork,
  metadataCitationHost,
  publicCitationAddress,
} from './citation-network';
import {
  citationUri,
  validCitation,
  type GitCitation,
} from './citation-format';
import { citationLocalPath } from './citation-io';
import { ConfigurationError } from './errors';
import type { StatusEnvironment } from './status';
import { CLI_VERSION } from './types';

export const SOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const SOURCE_TIMEOUT_MS = 15_000;
export const SOURCE_CONCURRENCY = 4;
export type SourceCheck =
  | { status: 'current'; sha256: string }
  | { status: 'missing' | 'unreachable' | 'malformed'; reason?: string };

/** File sources are checkout-relative, even when scanning a subdirectory. */
export async function citationCheckoutRoot(start: string): Promise<string> {
  let current = start;
  while (true) {
    try {
      await lstat(join(current, '.git'));
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return start;
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/** Hash binary bytes with bounded memory, rejecting symlinks and special files. */
export async function hashCitationFile(
  root: string,
  path: string,
): Promise<SourceCheck> {
  try {
    const target = await citationLocalPath(root, path);
    const before = await lstat(target);
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino ||
        (await realpath(target)) !== target
      )
        return { status: 'malformed' };
      if (opened.size > SOURCE_MAX_BYTES)
        return { status: 'unreachable', reason: 'too_large' };
      await citationLocalPath(root, path);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      // Bound the read to the initial size, then detect a concurrent change.
      while (position < opened.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, opened.size - position),
          position,
        );
        if (!bytesRead) return { status: 'unreachable' };
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      await citationLocalPath(root, path);
      const after = await lstat(target);
      const final = await handle.stat();
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        final.size !== opened.size ||
        final.mtimeMs !== opened.mtimeMs ||
        final.ctimeMs !== opened.ctimeMs
      )
        return { status: 'unreachable' };
      return { status: 'current', sha256: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? 'missing'
          : error instanceof ConfigurationError || code === 'ELOOP'
            ? 'malformed'
            : 'unreachable',
    };
  }
}

/** Anonymous GET only. One deadline covers headers, redirects and streamed bytes. */
export async function fetchCitationSource(
  uri: string,
  env: Pick<StatusEnvironment, 'fetch' | 'citationNetwork'>,
): Promise<SourceCheck> {
  if (!citationUri(uri)) return { status: 'malformed' };
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  const timeout = new Promise<SourceCheck>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      cancel();
      resolve({ status: 'unreachable' });
    }, SOURCE_TIMEOUT_MS);
  });
  const request = async (): Promise<SourceCheck> => {
    let current = uri;
    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) return { status: 'unreachable' };
      const url = new URL(current);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (metadataCitationHost(hostname))
        return { status: 'unreachable', reason: 'blocked_metadata_hostname' };
      const network = env.citationNetwork ?? citationNetwork;
      const family = isIP(hostname);
      let addresses;
      try {
        addresses = family
          ? [{ address: hostname, family }]
          : await network.lookup(hostname);
      } catch {
        return { status: 'unreachable', reason: 'dns_failed' };
      }
      if (!addresses.length)
        return { status: 'unreachable', reason: 'dns_failed' };
      if (
        addresses.some(
          (address) =>
            address.family !== isIP(address.address) ||
            !publicCitationAddress(address.address),
        )
      )
        return { status: 'unreachable', reason: 'blocked_non_public_address' };
      if (controller.signal.aborted) return { status: 'unreachable' };
      const response = await network.request(url, addresses[0]!, {
        headers: {
          'User-Agent': `interfacedelta-cli/${CLI_VERSION}`,
          'Accept-Encoding': 'identity',
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        return { status: 'unreachable' };
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (redirects >= 3 || !location) return { status: 'unreachable' };
        current = new URL(location, current).href;
        if (!citationUri(current)) return { status: 'unreachable' };
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return {
          status:
            response.status === 404 || response.status === 410
              ? 'missing'
              : 'unreachable',
        };
      }
      const encoding = response.headers.get('content-encoding');
      const length = response.headers.get('content-length');
      // Native fetch decompresses bodies. Refuse encoded responses rather than hash different bytes.
      if (
        (encoding && encoding.toLowerCase() !== 'identity') ||
        (length !== null &&
          (!/^\d+$/.test(length) || Number(length) > SOURCE_MAX_BYTES))
      ) {
        void response.body?.cancel().catch(() => {});
        return { status: 'unreachable' };
      }
      const hash = createHash('sha256');
      reader = response.body?.getReader();
      let size = 0;
      if (reader) {
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > SOURCE_MAX_BYTES) {
              cancel();
              return { status: 'unreachable' };
            }
            hash.update(value);
          }
        } finally {
          reader.releaseLock();
          reader = undefined;
        }
      }
      return controller.signal.aborted
        ? { status: 'unreachable' }
        : { status: 'current', sha256: hash.digest('hex') };
    }
  };
  try {
    return await Promise.race([request(), timeout]);
  } catch {
    cancel();
    return { status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export function parseGitSource(value: string): GitCitation {
  const match =
    /^(https:\/\/[^\s]+)@([a-fA-F0-9]{64}|[a-fA-F0-9]{40})(?::(.+))?$/.exec(
      value,
    );
  const citation: GitCitation = {
    kind: 'git',
    repo: match?.[1] ?? '',
    commit: match?.[2] ?? '',
    ...(match?.[3] !== undefined ? { path: match[3] } : {}),
  };
  if (!validCitation(citation))
    throw new ConfigurationError(
      '--git requires an HTTPS repository@full-commit[:path] without credentials.',
    );
  return citation;
}
