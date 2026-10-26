import { isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export type ResolvedAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};
export type Resolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export class TargetPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const blockedNames = new Set([
  'localhost',
  'localhost.localdomain',
  'local',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
]);
const blockedSuffixes = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.test',
  '.invalid',
  '.example',
  '.onion',
];

export function parsePublicHttpsOrigin(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TargetPolicyError('INVALID_URL', 'Enter an absolute HTTPS URL.');
  }
  if (parsed.protocol !== 'https:')
    throw new TargetPolicyError(
      'HTTPS_REQUIRED',
      'Only HTTPS URLs are supported.',
    );
  if (parsed.username || parsed.password)
    throw new TargetPolicyError(
      'CREDENTIALS_FORBIDDEN',
      'URLs must not contain credentials.',
    );
  if (parsed.port && parsed.port !== '443')
    throw new TargetPolicyError(
      'PORT_FORBIDDEN',
      'Only effective port 443 is supported.',
    );
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || isIP(hostname.replace(/^\[|\]$/g, '')))
    throw new TargetPolicyError(
      'IP_LITERAL_FORBIDDEN',
      'IP-literal hosts are not supported.',
    );
  if (
    !hostname.includes('.') ||
    blockedNames.has(hostname) ||
    blockedSuffixes.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new TargetPolicyError(
      'HOSTNAME_FORBIDDEN',
      'A public DNS hostname is required.',
    );
  }
  const labels = hostname.split('.');
  if (
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    )
  ) {
    throw new TargetPolicyError('HOSTNAME_INVALID', 'The hostname is invalid.');
  }
  return new URL(`https://${hostname}`);
}

export function parsePublicHttpsEndpoint(input: string): URL {
  const parsed = new URL(input);
  parsePublicHttpsOrigin(parsed.href);
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  parsed.port = '';
  return parsed;
}

export const systemResolver: Resolver = async (hostname) => {
  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENODATA' ? [] : Promise.reject(error),
    ),
    resolve6(hostname).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENODATA' ? [] : Promise.reject(error),
    ),
  ]);
  return [
    ...v4.map((address) => ({ address, family: 4 as const })),
    ...v6.map((address) => ({ address, family: 6 as const })),
  ];
};

export function assertAllAddressesPublic(
  addresses: readonly ResolvedAddress[],
): void {
  if (addresses.length === 0)
    throw new TargetPolicyError(
      'DNS_EMPTY',
      'The hostname returned no addresses.',
    );
  for (const result of addresses) {
    let address: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      address = ipaddr.parse(result.address);
    } catch {
      throw new TargetPolicyError(
        'DNS_INVALID_ADDRESS',
        'DNS returned an invalid address.',
      );
    }
    if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress())
      address = address.toIPv4Address();
    if (address.range() !== 'unicast') {
      throw new TargetPolicyError(
        'NON_PUBLIC_ADDRESS',
        'The hostname resolves to a non-public address.',
      );
    }
  }
}

export async function validateAndResolve(
  url: URL,
  resolver: Resolver,
): Promise<readonly ResolvedAddress[]> {
  const canonical = parsePublicHttpsOrigin(url.href);
  if (
    canonical.hostname !== url.hostname.toLowerCase().replace(/\.$/, '') ||
    (url.port && url.port !== '443')
  ) {
    throw new TargetPolicyError(
      'TARGET_INVALID',
      'The target does not meet the public HTTPS policy.',
    );
  }
  const addresses = await resolver(canonical.hostname);
  assertAllAddressesPublic(addresses);
  return addresses;
}
