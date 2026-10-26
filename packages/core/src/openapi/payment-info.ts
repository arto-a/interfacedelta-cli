import {
  OPENAPI_PAYMENT_DISCOVERY_SPECIFICATION,
  type OpenApiPaymentDeclaration,
  type OpenApiPaymentOffer,
  type OpenApiPaymentRejectionCode,
} from '@interfacedelta/contracts';

// Grammar: draft-payment-discovery-01 at tempoxyz/mpp-specs@08e7dd8, "Payment Extension: x-payment-info".
export const OPENAPI_PAYMENT_LIMITS = {
  maxOffers: 16,
  maxText: 512,
  maxAmount: 128,
} as const;

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : undefined;
const bounded = (value: string, max: number) =>
  Array.from(value).slice(0, max).join('');
const CANONICAL_AMOUNT = /^(0|[1-9][0-9]*)$/;

function offerFrom(
  raw: unknown,
  index: number,
  rejections: OpenApiPaymentDeclaration['rejections'][number][],
): OpenApiPaymentOffer | undefined {
  const reject = (code: OpenApiPaymentRejectionCode) =>
    rejections.push({ code, offerIndex: index });
  const offer = object(raw);
  if (!offer) {
    reject('offer_not_an_object');
    return undefined;
  }
  const textField = (key: string, missing?: OpenApiPaymentRejectionCode) => {
    const value = offer[key];
    if (typeof value === 'string' && value.length)
      return bounded(value, OPENAPI_PAYMENT_LIMITS.maxText);
    if (missing) reject(missing);
    return undefined;
  };
  const intent = textField('intent', 'intent_missing');
  const method = textField('method', 'method_missing');
  let amount: string | null | undefined;
  if (!Object.hasOwn(offer, 'amount')) reject('amount_missing');
  else if (offer.amount === null) amount = null;
  else if (typeof offer.amount === 'string') {
    amount = bounded(offer.amount, OPENAPI_PAYMENT_LIMITS.maxAmount);
    if (!CANONICAL_AMOUNT.test(offer.amount))
      reject('amount_not_canonical_digits');
  } else reject('amount_not_a_string');
  const optional = (key: string, invalid: OpenApiPaymentRejectionCode) => {
    if (offer[key] === undefined) return undefined;
    if (typeof offer[key] === 'string')
      return bounded(offer[key] as string, OPENAPI_PAYMENT_LIMITS.maxText);
    reject(invalid);
    return undefined;
  };
  return {
    intent,
    method,
    amount,
    currency: optional('currency', 'currency_not_a_string'),
    description: optional('description', 'description_not_a_string'),
  };
}

/**
 * Reads the per-operation `x-payment-info` extension, accepting both the
 * single-offer shorthand and the `offers` form as the spec requires. Returns
 * undefined when the operation carries no extension.
 */
export function extractOperationPaymentInfo(
  operation: Obj,
  declares402Response: boolean,
): OpenApiPaymentDeclaration | undefined {
  if (!Object.hasOwn(operation, 'x-payment-info')) return undefined;
  const raw = operation['x-payment-info'];
  const rejections: OpenApiPaymentDeclaration['rejections'][number][] = [];
  const extension = object(raw);
  const multi = extension !== undefined && Object.hasOwn(extension, 'offers');
  let entries: unknown[] = [];
  if (!extension) rejections.push({ code: 'extension_not_an_object' });
  else if (!multi) entries = [extension];
  else if (!Array.isArray(extension.offers))
    rejections.push({ code: 'offers_not_an_array' });
  else if (!extension.offers.length) rejections.push({ code: 'offers_empty' });
  else entries = extension.offers;
  const offers = entries
    .slice(0, OPENAPI_PAYMENT_LIMITS.maxOffers)
    .map((entry, index) => offerFrom(entry, index, rejections))
    .filter((offer): offer is OpenApiPaymentOffer => offer !== undefined);
  if (!declares402Response)
    rejections.push({ code: 'no_402_response_declared' });
  return {
    specification: OPENAPI_PAYMENT_DISCOVERY_SPECIFICATION,
    evidenceClass: 'publisher_declared',
    form: multi ? 'multi_offer' : 'single_offer',
    offers,
    offersTruncated: entries.length > OPENAPI_PAYMENT_LIMITS.maxOffers,
    declares402Response,
    rejections,
  };
}

/**
 * The Passport's view of a declaration: which methods and intents are offered,
 * never the amount or the pricing note, so a price edit cannot move a
 * fingerprint or surface a price.
 */
export function summarizePaymentDeclaration(
  declaration: OpenApiPaymentDeclaration | undefined,
) {
  if (!declaration) return undefined;
  return {
    offers: declaration.offers.map((offer) => ({
      intent: offer.intent,
      method: offer.method,
      currency: offer.currency,
      pricing:
        offer.amount === null
          ? 'dynamic'
          : typeof offer.amount === 'string' &&
              CANONICAL_AMOUNT.test(offer.amount)
            ? 'fixed'
            : 'unrecognized',
    })),
    offersTruncated: declaration.offersTruncated,
    declares402Response: declaration.declares402Response,
    rejectionCodes: [
      ...new Set(declaration.rejections.map((item) => item.code)),
    ].sort(),
  };
}
