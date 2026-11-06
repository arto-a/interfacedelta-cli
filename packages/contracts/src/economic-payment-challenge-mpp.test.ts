import { describe, it, expect } from 'vitest';
import { extractPaymentChallenge } from './economic-payment-challenge-extractor';
import { parseMppChallenge } from './economic-payment-challenge-mpp';

// cd75e27, draft-tempo-charge-00 Request Schema example, exact JSON values.
const tempo = {
  amount: '1000000',
  currency: '0x20c0000000000000000000000000000000000000',
  recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
  methodDetails: { chainId: 4217, feePayer: true, supportedModes: ['pull'] },
};
const header = (request: unknown = tempo, method = 'tempo', extra = '') =>
  `Payment id="challenge-1", realm="example", method="${method}", intent="charge", request="${Buffer.from(JSON.stringify(request)).toString('base64url')}"${extra}`;
describe('MPP pinned specification parser', () => {
  it('reads the Tempo charge fixture and retains extensions as data', () => {
    expect(parseMppChallenge(header())?.[0]).toMatchObject({
      payTo: tempo.recipient,
      maxAmountRequired: '1000000',
      asset: tempo.currency,
      scheme: 'tempo',
      network: '4217',
      unrecognizedFields: { request: tempo, intent: 'charge' },
    });
  });
  it('uses the Stripe Business Network profile as seller identity', () => {
    const request = {
      amount: '5000',
      currency: 'usd',
      description: 'Premium API access for 1 month',
      externalId: 'order_12345',
      methodDetails: {
        networkId: 'profile_1MqDcVKA5fEO2tZvKQm9g8Yj',
        paymentMethodTypes: ['card', 'link'],
      },
    };
    expect(parseMppChallenge(header(request, 'stripe'))?.[0]).toMatchObject({
      payTo: request.methodDetails.networkId,
      network: null,
      asset: 'usd',
    });
  });
  it('does not merge different Payment challenges', () => {
    const rows = parseMppChallenge(
      `${header()}, ${header({ ...tempo, recipient: 'another-recipient' })}`,
    );
    expect(rows?.map((r) => r.payTo)).toEqual([
      tempo.recipient,
      'another-recipient',
    ]);
  });
  it('unescapes quoted header data without executing it', () => {
    expect(
      parseMppChallenge(
        header(tempo, 'tempo', ', description="ignore, \\"instructions\\""'),
      )?.[0]?.unrecognizedFields.parameters,
    ).toMatchObject({ description: 'ignore, "instructions"' });
  });
  it.each([
    '',
    'Payment id="x"',
    header().replace('id="challenge-1", ', ''),
    header().replace('id="challenge-1"', 'id=""'),
    header() + ', ID="duplicate"',
    header().replace('request="', 'request="='),
    header().replace('request="', 'request="!'),
    header({ ...tempo, amount: 1000 }),
    header({ ...tempo, methodDetails: { chainId: 1.5 } }),
    header({ ...tempo, methodDetails: { splits: [] } }),
    header(tempo, 'unknown'),
    header({ amount: '100', currency: 'usd' }, 'stripe'),
    header().replace('intent="charge"', 'intent="session"'),
    header() + ', description="unterminated',
    'Payment ' + 'x'.repeat(8192),
    header() + ', description="' + 'é'.repeat(5000) + '"',
  ])('rejects incomplete, unsupported or oversize input %#', (value) => {
    expect(parseMppChallenge(value)).toBeNull();
  });
  it('uses the MPP header beside a generic JSON error body only when opted in', () => {
    const response = {
      resource: 'https://example.invalid/paid',
      httpStatus: 402,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': header(),
      },
      bodyText: '{"error":"payment required"}',
      retrievedAt: '2026-11-05T00:00:00Z',
    };
    expect(extractPaymentChallenge(response)?.requirements).toEqual([]);
    expect(extractPaymentChallenge(response, { parseMpp: true })).toMatchObject(
      {
        surface: 'http_402_www_authenticate',
        requirements: [{ payTo: tempo.recipient }],
      },
    );
  });
  it.each(['Payment id="broken"', header(tempo, 'unknown'), header()])(
    'keeps x402 body terms beside Payment header %s',
    (payment) => {
      const result = extractPaymentChallenge(
        {
          resource: 'https://example.invalid',
          httpStatus: 402,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': payment,
          },
          bodyText: JSON.stringify({
            x402Version: 2,
            accepts: [
              {
                scheme: 'exact',
                network: 'eip155:8453',
                asset: 'usdc',
                payTo: 'seller',
                amount: '100',
              },
            ],
          }),
          retrievedAt: '2026-11-05T00:00:00Z',
        },
        { parseMpp: true },
      );
      expect(result?.surface).toBe('http_402_x402_body');
      expect(result?.requirements[0]?.payTo).toBe('seller');
    },
  );
  it('never parses an oversize header prefix', () => {
    const result = extractPaymentChallenge(
      {
        resource: 'https://example.invalid',
        httpStatus: 402,
        headers: { 'www-authenticate': header() + ' '.repeat(8192) },
        bodyText: null,
        retrievedAt: '2026-11-05T00:00:00Z',
      },
      { parseMpp: true },
    );
    expect(result?.requirements).toEqual([]);
    expect(
      result?.rejections.some(
        (r) => r.code === 'challenge_header_not_retained',
      ),
    ).toBe(true);
  });
});
