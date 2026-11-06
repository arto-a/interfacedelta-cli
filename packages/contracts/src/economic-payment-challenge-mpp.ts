import type { EconomicDeclaredRequirement } from './economic-payment-challenge';

const path = '$.headers["www-authenticate"]';
const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const parameter = new RegExp(
  `^(${token})[ \\t]*=[ \\t]*(${token}|"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*")`,
);
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): string | null =>
  typeof x === 'string' && x.length > 0 ? x : null;

/** Pinned draft-httpauth-payment-01, cd75e27. No credential processing. */
export function parseMppChallenge(
  header: string,
): EconomicDeclaredRequirement[] | null {
  // Split only outside quoted strings. Scheme boundaries are distinguished
  // from auth-params by '='; never merge fields from separate challenges.
  if (Buffer.byteLength(header, 'utf8') > 8192 || /[^\x20-\x7e\t]/.test(header))
    return null;
  const segments = header.match(/(?:[^,"\\]|"(?:[^"\\]|\\.)*")+/g);
  if (!segments || segments.join(',') !== header) return null;
  const challenges: { scheme: string; params: Record<string, string> }[] = [];
  for (const segment of segments) {
    let part = segment.trim();
    const scheme = /^([A-Za-z][A-Za-z0-9_-]*) +(?=[^=]+(?:=|$))/.exec(part);
    if (scheme) {
      challenges.push({
        scheme: scheme[1]!.toLowerCase(),
        params: Object.create(null),
      });
      part = part.slice(scheme[0].length);
    }
    const challenge = challenges.at(-1);
    if (!challenge) return null;
    const match = parameter.exec(part);
    if (!match || match[0].length !== part.length) return null;
    const name = match[1]!.toLowerCase();
    if (Object.hasOwn(challenge.params, name)) return null;
    const value = match[2]!;
    challenge.params[name] = value.startsWith('"')
      ? value.slice(1, -1).replace(/\\(.)/g, '$1')
      : value;
  }
  const payments = challenges.filter((c) => c.scheme === 'payment');
  if (!payments.length || payments.length > 16) return null;
  const requirements: EconomicDeclaredRequirement[] = [];
  for (const { params } of payments) {
    if (
      !params.id ||
      params.realm === undefined ||
      !params.method ||
      !/^[a-z][a-z0-9_-]*$/.test(params.method) ||
      !params.intent ||
      !/^[a-z][a-z0-9_-]*$/.test(params.intent) ||
      !params.request ||
      !/^[A-Za-z0-9_-]+$/.test(params.request)
    )
      return null;
    try {
      const bytes = Buffer.from(params.request, 'base64url');
      if (bytes.toString('base64url') !== params.request) return null;
      const request: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
      if (!object(request)) return null;
      // Unknown methods/intents remain data, never guessed payment identities.
      if (
        !['tempo', 'stripe'].includes(params.method) ||
        params.intent !== 'charge'
      )
        return null;
      if (
        !text(request.amount) ||
        !text(request.currency) ||
        (request.recipient !== undefined && !text(request.recipient)) ||
        (params.method === 'tempo' && !text(request.recipient))
      )
        return null;
      const details = request.methodDetails;
      if (details !== undefined && !object(details)) return null;
      const chain = object(details) ? details.chainId : undefined;
      if (
        chain !== undefined &&
        (typeof chain !== 'number' || !Number.isSafeInteger(chain) || chain < 0)
      )
        return null;
      const networkId = object(details) ? details.networkId : undefined;
      if (networkId !== undefined && !text(networkId)) return null;
      if (params.method === 'stripe' && !text(networkId)) return null;
      // Keep all request and header fields as data, including intent, volatile
      // challenge ids, unknown extensions and splits. Only the primary seller
      // identity is modelled; split requests are not comparable until modelled fully.
      if (object(details) && details.splits !== undefined) return null;
      requirements.push({
        ordinal: requirements.length,
        scheme: params.method,
        network:
          params.method === 'tempo'
            ? chain === undefined
              ? null
              : String(chain)
            : null,
        asset: text(request.currency),
        // Stripe's required Business Network profile identifies the seller.
        // Optional recipient and the entire request remain retained as data.
        payTo:
          params.method === 'stripe'
            ? text(networkId)
            : text(request.recipient),
        maxAmountRequired: text(request.amount),
        maxTimeoutSeconds: null,
        unrecognizedFields: {
          request,
          parameters: params,
          intent: params.intent,
        },
        evidencePath: `${path}.Payment[${requirements.length}].request`,
      });
    } catch {
      return null;
    }
  }
  return requirements;
}
