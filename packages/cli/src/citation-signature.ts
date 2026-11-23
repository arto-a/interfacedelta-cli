import { createPublicKey, verify } from 'node:crypto';
import { ConfigurationError } from './errors';
import { canonicalJson } from '@interfacedelta/core';

export const CITATION_KEYS = '.interfacedelta/citations/keys.json';
export const CHECK_VERIFY_URL =
  'https://interfacedelta.com/api/v1/record/check/verify';
export function citationObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Offline detached JWS verification with the published { keys: [JWK] } format. */
export function verifyCitationAnswer(
  input: unknown,
  publishedKeys: unknown,
): boolean {
  try {
    const { signature, ...body } = citationObject(input);
    if (
      body.recordCheck !== '1' ||
      !['observed', 'removed', 'not_observed', 'requires_sign_in'].includes(
        String(body.status),
      )
    )
      return false;
    const sig = citationObject(signature);
    if (
      Object.keys(sig).sort().join(',') !== 'jws,verify' ||
      sig.verify !== CHECK_VERIFY_URL ||
      typeof sig.jws !== 'string'
    )
      return false;
    const [protectedPart, detached, signaturePart, extra] = sig.jws.split('.');
    if (
      !protectedPart ||
      detached !== '' ||
      !signaturePart ||
      extra !== undefined ||
      !/^[\w-]+$/.test(protectedPart) ||
      !/^[\w-]+$/.test(signaturePart)
    )
      return false;
    const bytes = Buffer.from(signaturePart, 'base64url');
    if (bytes.length !== 64 || bytes.toString('base64url') !== signaturePart)
      return false;
    const header = citationObject(
      JSON.parse(Buffer.from(protectedPart, 'base64url').toString('utf8')),
    );
    if (
      Object.keys(header).sort().join(',') !== 'alg,kid,typ' ||
      header.alg !== 'EdDSA' ||
      header.typ !== 'interfacedelta-record-check+jws' ||
      typeof header.kid !== 'string'
    )
      return false;
    const keys = citationObject(publishedKeys).keys;
    if (!Array.isArray(keys)) return false;
    const matching = keys
      .map(citationObject)
      .filter(
        (key) =>
          key.kid === header.kid &&
          key.kty === 'OKP' &&
          key.crv === 'Ed25519' &&
          key.alg === 'EdDSA' &&
          key.d === undefined,
      );
    return (
      matching.length === 1 &&
      verify(
        null,
        Buffer.from(
          `${protectedPart}.${Buffer.from(canonicalJson(body)).toString('base64url')}`,
        ),
        createPublicKey({ key: matching[0]!, format: 'jwk' }),
        bytes,
      )
    );
  } catch {
    return false;
  }
}

/** Retain every trusted kid; a reused kid must never change its key material. */
export function mergeCitationKeys(existing: unknown, fetched: unknown) {
  const byKid = new Map<string, Record<string, unknown>>();
  for (const snapshot of [existing, fetched]) {
    const keys = citationObject(snapshot).keys;
    if (!Array.isArray(keys))
      throw new ConfigurationError(
        'Citation keys snapshot must contain public keys.',
      );
    const seen = new Set<string>();
    for (const value of keys) {
      const key = citationObject(value);
      if (
        typeof key.kid !== 'string' ||
        !key.kid ||
        seen.has(key.kid) ||
        key.kty !== 'OKP' ||
        key.crv !== 'Ed25519' ||
        key.alg !== 'EdDSA' ||
        key.d !== undefined ||
        typeof key.x !== 'string'
      )
        throw new ConfigurationError(
          'Citation keys snapshot must contain unique public Ed25519 kids.',
        );
      seen.add(key.kid);
      const prior = byKid.get(key.kid);
      if (prior && prior.x !== key.x)
        throw new ConfigurationError(
          'Citation key material changed for an existing kid.',
        );
      if (!prior) byKid.set(key.kid, key);
    }
  }
  return { keys: [...byKid.keys()].sort().map((kid) => byKid.get(kid)!) };
}
