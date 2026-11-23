import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/** Explicit injection for offline tests; production always uses pinned HTTPS. */
export type CitationNetwork = {
  lookup: (hostname: string) => Promise<LookupAddress[]>;
  request: (
    url: URL,
    address: LookupAddress,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<Response>;
};

export function publicCitationAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (family !== 6) return false;
  // WHATWG normalizes dotted IPv4 tails to hex, then expand the one :: gap.
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = normalized.split('::');
  const first = left ? left.split(':') : [];
  const last = right ? right.split(':') : [];
  const words = (
    right === undefined
      ? first
      : [
          ...first,
          ...Array<string>(8 - first.length - last.length).fill('0'),
          ...last,
        ]
  ).map((word) => parseInt(word, 16));
  if (words.slice(0, 5).every((word) => word === 0)) {
    if (words[5] === 0xffff) {
      return publicCitationAddress(
        `${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`,
      );
    }
    // Unspecified, loopback and deprecated IPv4-compatible addresses.
    if (words[5] === 0) return false;
  }
  return !(
    (words[0]! & 0xfe00) === 0xfc00 ||
    (words[0]! & 0xffc0) === 0xfe80 ||
    (words[0]! & 0xff00) === 0xff00
  );
}

export function metadataCitationHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return [
    'localhost',
    'localhost.localdomain',
    'metadata',
    'metadata.google.internal',
    'metadata.goog',
    'metadata.azure.internal',
    'metadata.tencentyun.com',
    'instance-data',
    'instance-data.ec2.internal',
  ].some((name) => host === name || host.endsWith(`.${name}`));
}

/** No pooled sockets or second DNS lookup; TLS/Host still use the original URL. */
export const pinnedCitationRequest: CitationNetwork['request'] = (
  url,
  address,
  init,
) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        headers: init.headers,
        signal: init.signal,
        agent: false,
        family: address.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, address.address, address.family),
      },
      (response) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined)
              headers.set(
                name,
                Array.isArray(value) ? value.join(', ') : value,
              );
          }
          const status = response.statusCode ?? 502;
          const noBody = [204, 205, 304].includes(status);
          if (noBody) response.destroy();
          resolve(
            new Response(
              noBody
                ? null
                : (Readable.toWeb(response, {
                    strategy: {
                      highWaterMark: 64 * 1024,
                      size: (chunk: Uint8Array) => chunk.byteLength,
                    },
                  }) as ReadableStream<Uint8Array>),
              { status, headers },
            ),
          );
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    request.on('error', reject);
    request.end();
  });

export const citationNetwork: CitationNetwork = {
  lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  request: pinnedCitationRequest,
};
