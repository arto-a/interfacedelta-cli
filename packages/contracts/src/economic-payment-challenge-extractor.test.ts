import { describe, expect, it } from 'vitest';
import {
  PAYMENT_CHALLENGE_EXTRACTOR_VERSION,
  PAYMENT_CHALLENGE_HEADER_MAX_CHARS,
  PAYMENT_REQUIRED_HEADER_MAX_CHARS,
  extractPaymentChallenge,
  type RetrievedResponse,
} from './economic-payment-challenge-extractor';

const base: RetrievedResponse = {
  resource: 'https://example.invalid/api/thing',
  httpStatus: 402,
  headers: { 'content-type': 'application/json' },
  bodyText: null,
  retrievedAt: '2026-09-22T00:00:00.000Z',
};

/**
 * Modelled on the retained September evidence: the `accepts[]` member shape
 * is taken from the verified `r07-merchant-query.json` bytes, minus the
 * `recipient` alias and `extra.credentialTypes`. The surrounding 402
 * envelope is constructed — every retained sample was a 200 or a 404, so no
 * real payment challenge was ever observed.
 */
const x402Body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x2222222222222222222222222222222222222222',
        maxAmountRequired: '5000',
        maxTimeoutSeconds: 3600,
        amount: '5000',
        currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
    ...overrides,
  });

/**
 * The `PAYMENT-REQUIRED` value from the x402 v2 HTTP transport specification
 * (coinbase/x402 specs/transports-v2/http.md, "Payment Required Signaling"),
 * copied byte for byte. It decodes to one `exact` option on eip155:84532.
 */
const SPEC_PAYMENT_REQUIRED =
  'eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQQVlNRU5ULVNJR05BVFVSRSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcmVtaXVtLWRhdGEiLCJkZXNjcmlwdGlvbiI6IkFjY2VzcyB0byBwcmVtaXVtIG1hcmtldCBkYXRhIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6ImVpcDE1NTo4NDUzMiIsImFtb3VudCI6IjEwMDAwIiwiYXNzZXQiOiIweDAzNkNiRDUzODQyYzU0MjY2MzRlNzkyOTU0MWVDMjMxOGYzZENGN2UiLCJwYXlUbyI6IjB4MjA5NjkzQmM2YWZjMEM1MzI4YkEzNkZhRjAzQzUxNEVGMzEyMjg3QyIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsibmFtZSI6IlVTREMiLCJ2ZXJzaW9uIjoiMiJ9fV19';

const encodeHeader = (value: unknown) =>
  Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  ).toString('base64');

describe('publisher-native payment challenge extraction', () => {
  it('labels every stored challenge with extractor v2', () => {
    expect(PAYMENT_CHALLENGE_EXTRACTOR_VERSION).toBe(
      'payment-challenge-extractor-v2',
    );
  });

  describe('what is and is not a challenge', () => {
    it.each([200, 401, 403, 404, 500])(
      'returns null for HTTP %i',
      (httpStatus) => {
        expect(
          extractPaymentChallenge({
            ...base,
            httpStatus,
            bodyText: x402Body(),
          }),
        ).toBeNull();
      },
    );

    it('treats 401 as an authentication barrier, not a price', () => {
      // A 401 carrying a *Payment* challenge is still not a payment
      // requirement. Asserting on a Bearer header would have passed for the
      // wrong reason: the status check fires before any header is read.
      expect(
        extractPaymentChallenge({
          ...base,
          httpStatus: 401,
          headers: { 'www-authenticate': 'Payment amount="5"' },
          bodyText: x402Body(),
        }),
      ).toBeNull();
    });

    it('extracts from a 402', () => {
      const o = extractPaymentChallenge({ ...base, bodyText: x402Body() });
      expect(o?.surface).toBe('http_402_x402_body');
      expect(o?.httpStatus).toBe(402);
    });
  });

  describe('exact values are preserved', () => {
    it('keeps declared amounts as text and never as numbers', () => {
      const o = extractPaymentChallenge({ ...base, bodyText: x402Body() });
      const r = o!.requirements[0];
      expect(r.maxAmountRequired).toBe('5000');
      expect(typeof r.maxAmountRequired).toBe('string');
      // A numeric timeout is stringified rather than reinterpreted.
      expect(r.maxTimeoutSeconds).toBe('3600');
    });

    it('does not lose precision on a very large amount', () => {
      const huge = '123456789012345678901234567890';
      const o = extractPaymentChallenge({
        ...base,
        bodyText: JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: 'exact', maxAmountRequired: huge }],
        }),
      });
      expect(o!.requirements[0].maxAmountRequired).toBe(huge);
    });

    it('retains publisher fields it does not model', () => {
      const o = extractPaymentChallenge({ ...base, bodyText: x402Body() });
      const unrecognized = o!.requirements[0].unrecognizedFields;
      // `amount` and `currency` are deliberately not merged into the modelled
      // fields; they are kept verbatim so a reader sees what was actually sent.
      expect(unrecognized).toMatchObject({
        amount: '5000',
        currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        extra: { name: 'USD Coin', version: '2' },
      });
    });

    it('records the declared protocol version verbatim', () => {
      const o = extractPaymentChallenge({ ...base, bodyText: x402Body() });
      expect(o!.declaredProtocolVersion).toBe('2');
    });

    it('keeps duplicate declarations with their ordinals', () => {
      const one = {
        scheme: 'exact',
        network: 'eip155:8453',
        maxAmountRequired: '5000',
      };
      const o = extractPaymentChallenge({
        ...base,
        bodyText: JSON.stringify({ x402Version: 2, accepts: [one, one] }),
      });
      expect(o!.requirements).toHaveLength(2);
      expect(o!.requirements.map((r) => r.ordinal)).toEqual([0, 1]);
      expect(o!.requirements.map((r) => r.evidencePath)).toEqual([
        '$.accepts[0]',
        '$.accepts[1]',
      ]);
    });
  });

  describe('failures are recorded, never guessed', () => {
    it('rejects a body that is not valid JSON', () => {
      const o = extractPaymentChallenge({
        ...base,
        bodyText: 'not json at all',
      });
      expect(o!.requirements).toHaveLength(0);
      expect(o!.rejections[0]).toMatchObject({
        code: 'body_not_valid_utf8_json',
        evidencePath: '$',
      });
    });

    it('rejects an envelope with no accepts array', () => {
      const o = extractPaymentChallenge({
        ...base,
        bodyText: JSON.stringify({ x402Version: 2 }),
      });
      expect(o!.rejections[0]).toMatchObject({
        code: 'no_requirements_declared',
        evidencePath: '$.accepts',
      });
    });

    it('rejects an empty accepts array rather than reporting success', () => {
      const o = extractPaymentChallenge({
        ...base,
        bodyText: JSON.stringify({ x402Version: 2, accepts: [] }),
      });
      expect(o!.requirements).toHaveLength(0);
      expect(o!.rejections[0].code).toBe('no_requirements_declared');
    });

    it('rejects one malformed entry while keeping its valid siblings', () => {
      const o = extractPaymentChallenge({
        ...base,
        bodyText: JSON.stringify({
          x402Version: 2,
          accepts: [
            { scheme: 'exact', maxAmountRequired: '1' },
            'not-an-object',
          ],
        }),
      });
      expect(o!.requirements).toHaveLength(1);
      expect(o!.rejections[0]).toMatchObject({
        code: 'malformed_requirement',
        evidencePath: '$.accepts[1]',
      });
    });

    it('records a 402 with no retained body', () => {
      const o = extractPaymentChallenge({
        ...base,
        bodyText: null,
        headers: {},
      });
      expect(o!.requirements).toHaveLength(0);
      expect(o!.rejections[0].code).toBe('malformed_envelope');
    });

    it('flags an amount that arrived as a JSON number', () => {
      // JSON numbers are doubles, so precision may already be gone.
      const o = extractPaymentChallenge({
        ...base,
        bodyText:
          '{"x402Version":2,"accepts":[{"scheme":"exact","maxAmountRequired":123456789012345678901234567890}]}',
      });
      expect(o!.rejections.some((r) => r.code === 'amount_not_a_string')).toBe(
        true,
      );
    });

    it('leaves absent fields null rather than inventing them', () => {
      const o = extractPaymentChallenge({
        ...base,
        bodyText: JSON.stringify({ accepts: [{ scheme: 'exact' }] }),
      });
      const r = o!.requirements[0];
      expect(r.network).toBeNull();
      expect(r.asset).toBeNull();
      expect(r.payTo).toBeNull();
      expect(r.maxAmountRequired).toBeNull();
      expect(o!.declaredProtocolVersion).toBeNull();
    });
  });

  describe('WWW-Authenticate challenges are retained, not parsed', () => {
    const headerResponse = (value: string): RetrievedResponse => ({
      ...base,
      headers: { 'WWW-Authenticate': value, 'content-type': 'text/plain' },
      bodyText: null,
    });

    it('retains the header verbatim and declares nothing', () => {
      // No validated grammar and no observed challenge exist, so parsing
      // would be guessing. The bytes are kept; no requirement is invented.
      const raw = 'Payment id="abc", realm="api", method="invoice"';
      const o = extractPaymentChallenge(headerResponse(raw));
      expect(o!.surface).toBe('http_402_www_authenticate');
      expect(o!.rawChallengeHeader).toBe(raw);
      expect(o!.requirements).toHaveLength(0);
      expect(o!.rejections[0]).toMatchObject({
        code: 'challenge_grammar_not_validated',
        evidencePath: '$.headers["www-authenticate"]',
      });
    });

    it('treats an empty header as absent instead of throwing', () => {
      // A publisher-controlled empty header previously failed the schema's
      // non-empty rule and threw out of the whole inspection.
      const json = (value: string): RetrievedResponse => ({
        ...base,
        headers: {
          'WWW-Authenticate': value,
          'content-type': 'application/json',
        },
        bodyText: '{}',
      });
      expect(extractPaymentChallenge(json(''))!.rawChallengeHeader).toBeNull();
      const bare = extractPaymentChallenge(headerResponse(''));
      expect(bare!.surface).toBe('http_402_x402_body');
      expect(bare!.rawChallengeHeader).toBeNull();
    });

    it('does not throw on a malformed parameter', () => {
      // An empty quoted value previously escaped as a ZodError out of a
      // function whose whole purpose is never to lose or invent evidence.
      expect(() =>
        extractPaymentChallenge(headerResponse('Payment amount=""')),
      ).not.toThrow();
    });

    it('does not merge a second challenge into the first', () => {
      // Two challenges in one header are legal. Parsing previously absorbed
      // Bearer's realm into the Payment requirement, asserting a value came
      // from somewhere it did not.
      const raw = 'Payment amount="5", Bearer realm="api"';
      const o = extractPaymentChallenge(headerResponse(raw));
      expect(o!.rawChallengeHeader).toBe(raw);
      expect(o!.requirements).toHaveLength(0);
    });

    it('does not present a token68 challenge as a declaration', () => {
      const o = extractPaymentChallenge(headerResponse('Payment abcdef123=='));
      expect(o!.requirements).toHaveLength(0);
      expect(o!.rejections).toHaveLength(1);
    });

    it('matches the header name case-insensitively', () => {
      const o = extractPaymentChallenge({
        ...base,
        headers: { 'www-AUTHENTICATE': 'Payment amount="7"' },
        bodyText: null,
      });
      expect(o!.rawChallengeHeader).toBe('Payment amount="7"');
    });

    it('keeps the challenge header even when the body is the parsed surface', () => {
      // A body that fails to parse must not cause a challenge to be lost.
      const o = extractPaymentChallenge({
        ...base,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': 'Payment amount="5"',
        },
        bodyText: 'not json',
      });
      expect(o!.surface).toBe('http_402_x402_body');
      expect(o!.rawChallengeHeader).toBe('Payment amount="5"');
      expect(o!.rejections[0].code).toBe('body_not_valid_utf8_json');
    });
  });

  describe('the x402 v2 PAYMENT-REQUIRED header', () => {
    const headerPath = '$.headers["payment-required"]';

    it.each([
      ['an empty JSON object body', '{}', 'application/json'],
      ['no retained body', null, 'application/json'],
      ['a non-JSON body', 'Payment required', 'text/plain'],
    ])(
      'reads the specification example beside %s',
      (_label, bodyText, contentType) => {
        // A conformant v2 server may send nothing useful in the body. Version 1
        // recorded this as declaring nothing or as a malformed envelope.
        const o = extractPaymentChallenge({
          ...base,
          headers: {
            'content-type': contentType,
            'payment-required': SPEC_PAYMENT_REQUIRED,
          },
          bodyText,
        })!;
        expect(o.surface).toBe('http_402_x402_header');
        expect(o.declaredProtocolVersion).toBe('2');
        expect(o.rejections).toEqual([]);
        expect(o.requirements).toEqual([
          {
            ordinal: 0,
            scheme: 'exact',
            network: 'eip155:84532',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
            // v2 names the amount `amount`; it is kept verbatim, not renamed.
            maxAmountRequired: null,
            maxTimeoutSeconds: '60',
            unrecognizedFields: {
              amount: '10000',
              extra: { name: 'USDC', version: '2' },
            },
            evidencePath: `${headerPath}.accepts[0]`,
          },
        ]);
      },
    );

    it('prefers the canonical header to a body envelope, and says when they differ', () => {
      const o = extractPaymentChallenge({
        ...base,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': SPEC_PAYMENT_REQUIRED,
        },
        bodyText: x402Body(),
      })!;
      expect(o.surface).toBe('http_402_x402_header');
      expect(o.requirements).toHaveLength(1);
      expect(o.requirements[0]!.network).toBe('eip155:84532');
      expect(o.requirements[0]!.evidencePath).toBe(`${headerPath}.accepts[0]`);
      expect(o.rejections).toEqual([
        expect.objectContaining({
          code: 'body_differs_from_header',
          evidencePath: '$',
        }),
      ]);
    });

    it('does not call a mirrored body a disagreement, whatever its key order', () => {
      const decoded = JSON.parse(
        Buffer.from(SPEC_PAYMENT_REQUIRED, 'base64').toString('utf8'),
      ) as { accepts: Record<string, unknown>[] };
      const reordered = {
        accepts: decoded.accepts.map((entry) =>
          Object.fromEntries(Object.entries(entry).reverse()),
        ),
        x402Version: 2,
      };
      const o = extractPaymentChallenge({
        ...base,
        headers: {
          'content-type': 'application/json',
          'payment-required': SPEC_PAYMENT_REQUIRED,
        },
        bodyText: JSON.stringify(reordered),
      })!;
      expect(o.rejections).toEqual([]);
    });

    it('treats an empty PAYMENT-REQUIRED header as absent', () => {
      const o = extractPaymentChallenge({
        ...base,
        headers: { 'content-type': 'application/json', 'payment-required': '' },
        bodyText: x402Body(),
      })!;
      expect(o.surface).toBe('http_402_x402_body');
      expect(o.rejections).toEqual([]);
    });

    it('keeps the WWW-Authenticate header beside a header envelope', () => {
      const o = extractPaymentChallenge({
        ...base,
        headers: {
          'payment-required': SPEC_PAYMENT_REQUIRED,
          'www-authenticate': 'Payment id="a", realm="api"',
        },
      })!;
      expect(o.surface).toBe('http_402_x402_header');
      expect(o.rawChallengeHeader).toBe('Payment id="a", realm="api"');
    });

    it('records an envelope with no options as declaring nothing', () => {
      const o = extractPaymentChallenge({
        ...base,
        headers: {
          'payment-required': encodeHeader({ x402Version: 2, accepts: [] }),
        },
      })!;
      expect(o.requirements).toEqual([]);
      expect(o.rejections).toEqual([
        expect.objectContaining({
          code: 'no_requirements_declared',
          evidencePath: `${headerPath}.accepts`,
        }),
      ]);
    });

    it.each([
      ['not base64', 'not base64!'],
      ['base64url rather than base64', '-_-_'],
      ['impossible base64 length', 'abcde'],
      [
        'unpadded base64',
        // 47 bytes of JSON: padded, this ends in "=".
        encodeHeader({
          x402Version: 2,
          accepts: [{ scheme: 'upto' }],
        }).replace(/=+$/, ''),
      ],
      ['not UTF-8', Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')],
      ['not JSON', encodeHeader('payment please')],
      ['a JSON array', encodeHeader([{ scheme: 'exact' }])],
      [
        'over the decoding bound',
        'A'.repeat(PAYMENT_REQUIRED_HEADER_MAX_CHARS + 4),
      ],
    ])(
      'rejects a header that is %s and falls back to the body',
      (_label, value) => {
        const o = extractPaymentChallenge({
          ...base,
          headers: {
            'content-type': 'application/json',
            'payment-required': value,
          },
          bodyText: x402Body(),
        })!;
        expect(o.requirements).toHaveLength(1);
        expect(o.requirements[0]!.evidencePath).toBe('$.accepts[0]');
        expect(o.rejections).toEqual([
          expect.objectContaining({
            code: 'malformed_envelope',
            evidencePath: headerPath,
          }),
        ]);
      },
    );

    it('records an undecodable header even when nothing else was sent', () => {
      const o = extractPaymentChallenge({
        ...base,
        headers: { 'payment-required': '%%%' },
      })!;
      expect(o.requirements).toEqual([]);
      expect(o.rejections.map((r) => [r.code, r.evidencePath])).toEqual([
        ['malformed_envelope', '$'],
        ['malformed_envelope', headerPath],
      ]);
    });

    it('flags a v2 amount that arrived as a JSON number', () => {
      const o = extractPaymentChallenge({
        ...base,
        headers: {
          'payment-required': encodeHeader(
            '{"x402Version":2,"accepts":[{"scheme":"exact","amount":123456789012345678901234567890}]}',
          ),
        },
      })!;
      expect(o.rejections).toEqual([
        expect.objectContaining({
          code: 'amount_not_a_string',
          evidencePath: `${headerPath}.accepts[0].amount`,
        }),
      ]);
    });
  });

  describe('a longer WWW-Authenticate challenge', () => {
    it('keeps an MPP challenge whole up to the bound', () => {
      // draft-httpauth-payment-01 carries terms in a base64url `request`
      // parameter, which version 1's 512-character cut did not keep.
      const request = 'e'.repeat(PAYMENT_CHALLENGE_HEADER_MAX_CHARS - 200);
      const raw = `Payment id="x7Tg2pLqR9mKvNwY3hBcZa", realm="api.example.com", method="tempo", intent="charge", expires="2026-10-20T12:05:00Z", request="${request}"`;
      expect(raw.length).toBeLessThanOrEqual(
        PAYMENT_CHALLENGE_HEADER_MAX_CHARS,
      );
      const o = extractPaymentChallenge({
        ...base,
        headers: { 'www-authenticate': raw },
      })!;
      expect(o.surface).toBe('http_402_www_authenticate');
      expect(o.rawChallengeHeader).toBe(raw);
      expect(o.requirements).toEqual([]);
      expect(o.rejections.map((r) => r.code)).toEqual([
        'challenge_grammar_not_validated',
      ]);
    });

    it('reports a longer challenge as not retained rather than cutting it', () => {
      const raw = `Payment request="${'e'.repeat(PAYMENT_CHALLENGE_HEADER_MAX_CHARS)}"`;
      const o = extractPaymentChallenge({
        ...base,
        headers: { 'www-authenticate': raw },
      })!;
      expect(o.surface).toBe('http_402_www_authenticate');
      expect(o.rawChallengeHeader).toBeNull();
      expect(o.rejections).toEqual([
        expect.objectContaining({
          code: 'challenge_header_not_retained',
          detail: expect.stringMatching(/exceeded 8192 characters/),
          evidencePath: '$.headers["www-authenticate"]',
        }),
      ]);
    });

    it('still parses a body when its challenge header is oversize', () => {
      const o = extractPaymentChallenge({
        ...base,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': 'P'.repeat(
            PAYMENT_CHALLENGE_HEADER_MAX_CHARS + 1,
          ),
        },
        bodyText: x402Body(),
      })!;
      expect(o.requirements).toHaveLength(1);
      expect(o.rawChallengeHeader).toBeNull();
      expect(o.rejections.map((r) => r.code)).toEqual([
        'challenge_header_not_retained',
      ]);
    });
  });

  describe('empty challenge headers', () => {
    // A publisher-controlled empty header previously failed the schema's
    // non-empty rule and threw out of the whole inspection.
    it('treats an empty WWW-Authenticate as absent instead of throwing', () => {
      const json = extractPaymentChallenge({
        ...base,
        headers: { 'WWW-Authenticate': '', 'content-type': 'application/json' },
        bodyText: '{}',
      })!;
      expect(json.rawChallengeHeader).toBeNull();
      const bare = extractPaymentChallenge({
        ...base,
        headers: { 'www-authenticate': '', 'content-type': 'text/plain' },
        bodyText: null,
      })!;
      expect(bare.surface).toBe('http_402_x402_body');
      expect(bare.rawChallengeHeader).toBeNull();
    });

    it('reads a valid v2 header beside an empty WWW-Authenticate', () => {
      const o = extractPaymentChallenge({
        ...base,
        headers: {
          'www-authenticate': '',
          'payment-required': SPEC_PAYMENT_REQUIRED,
        },
      })!;
      expect(o.surface).toBe('http_402_x402_header');
      expect(o.rawChallengeHeader).toBeNull();
      expect(o.requirements).toHaveLength(1);
    });
  });

  describe('the claim boundary travels with every observation', () => {
    it('never reports settlement or delivery', () => {
      const o = extractPaymentChallenge({ ...base, bodyText: x402Body() });
      expect(o!.settlementObserved).toBe(false);
      expect(o!.deliveryObserved).toBe(false);
      expect(o!.claimStatement).toMatch(
        /not evidence that a payment was offered, authorized, made, or settled/,
      );
    });

    it('says the same thing on a rejected observation', () => {
      const o = extractPaymentChallenge({ ...base, bodyText: 'broken' });
      expect(o!.settlementObserved).toBe(false);
      expect(o!.deliveryObserved).toBe(false);
    });
  });

  describe('purity', () => {
    it('is deterministic for the same input', () => {
      const input = { ...base, bodyText: x402Body() };
      expect(extractPaymentChallenge(input)).toEqual(
        extractPaymentChallenge(input),
      );
    });

    it('does not mutate the response it was given', () => {
      const input = { ...base, bodyText: x402Body() };
      const snapshot = JSON.stringify(input);
      extractPaymentChallenge(input);
      expect(JSON.stringify(input)).toBe(snapshot);
    });
  });
});
