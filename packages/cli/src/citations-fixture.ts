import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalJson } from '@interfacedelta/core';
import { CHECK_VERIFY_URL } from './citation-signature';
import { skillAnswer, skillGoal, SKILLS_ENDPOINT } from './skills-fixture';
import { formatCitation, type ToolCitation } from './citation-format';

// Generated fixture keys exist only in this test module; no network or real keys.
const pair = generateKeyPairSync('ed25519');
export const citationKeys = {
  keys: [
    {
      ...pair.publicKey.export({ format: 'jwk' }),
      kid: 'citation-fixture',
      alg: 'EdDSA',
      use: 'sig',
    },
  ],
};
export const citationFixture: ToolCitation = {
  endpoint: SKILLS_ENDPOINT,
  tool: 'read_item',
  fingerprint: 'sha256:' + 'a'.repeat(64),
  checked: '2026-11-22',
};
export const citationLine = formatCitation(citationFixture);
export function signedCitationAnswer(
  overrides: Record<string, unknown> = {},
  signer: { privateKey: KeyObject; kid: string } = {
    privateKey: pair.privateKey,
    kid: 'citation-fixture',
  },
) {
  const {
    signature: _signature,
    changedSinceTime: _unsigned,
    ...body
  } = skillAnswer('read_item', {
    change: { fingerprint: citationFixture.fingerprint.slice(7), last: null },
    issuedAt: '2026-11-22T00:00:00Z',
    ...overrides,
  });
  void _signature;
  void _unsigned;
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: signer.kid,
      typ: 'interfacedelta-record-check+jws',
    }),
  ).toString('base64url');
  const signature = sign(
    null,
    Buffer.from(
      `${header}.${Buffer.from(canonicalJson(body)).toString('base64url')}`,
    ),
    signer.privateKey,
  ).toString('base64url');
  return {
    ...body,
    signature: { jws: `${header}..${signature}`, verify: CHECK_VERIFY_URL },
  };
}
export function citationGoal(answers = [signedCitationAnswer()]) {
  return skillGoal(
    answers.map((answer) => ({ ...answer, changedSinceTime: false })),
  );
}
