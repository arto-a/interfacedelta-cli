import {
  ECONOMIC_PAYMENT_CHALLENGE_VERSION,
  economicPaymentChallengeObservationSchema,
  type EconomicChallengeRejection,
  type EconomicDeclaredRequirement,
  type EconomicPaymentChallengeObservation,
} from './economic-payment-challenge';

/**
 * Publisher-native payment requirement extractor.
 *
 * Pure. It is handed bytes that were already retrieved — InterfaceDelta
 * already fetches these endpoints during Passport inspection — and returns
 * what the publisher declared. It opens no socket, reads no environment
 * variable and starts no timer, so importing it activates nothing and it adds
 * no request to any run.
 *
 * The passive MCP client runs it on the 402 received at first contact, and a
 * recorded observation stores the result.
 *
 * Version 2 reads two things version 1 left on the table, both from
 * the same response, so it still sends nothing:
 *
 * - The x402 v2 `PAYMENT-REQUIRED` header. The x402 v2 HTTP transport makes
 *   this base64-encoded `PaymentRequired` object the canonical location, and
 *   a conformant server may send an empty body beside it. Version 1 read only
 *   the body, so it recorded such a challenge as declaring nothing.
 * - A longer `WWW-Authenticate` value, so an MPP `Payment` challenge's
 *   `request` parameter survives. It is still retained, not parsed.
 *
 * A header-derived envelope is recorded under its own surface,
 * `http_402_x402_header`.
 * Only the decoded envelope is kept: the header's bytes are not hashed, and
 * the row's body hash and length remain the body's.
 *
 * OpenAPI `x-payment-info` is not handled here. An earlier root-level,
 * x402-shaped reader was retired because draft-payment-discovery-01 defines
 * per-operation offers; the OpenAPI observer reads those.
 *
 * The rule throughout: record exactly what was said, and say clearly when
 * something could not be understood. A field that cannot be parsed becomes a
 * rejection with an evidence path, never a silent omission and never a
 * guessed value.
 */

/** Identifies this extractor's parsing rules on every stored challenge. */
export const PAYMENT_CHALLENGE_EXTRACTOR_VERSION =
  'payment-challenge-extractor-v2' as const;

/**
 * Longest `WWW-Authenticate` value retained. draft-httpauth-payment-01 §9.4
 * asks servers to keep a challenge under 8 KB. A longer value is reported as
 * `challenge_header_not_retained` rather than cut, so a stored header is
 * always the whole header.
 */
export const PAYMENT_CHALLENGE_HEADER_MAX_CHARS = 8_192;

/**
 * Longest `PAYMENT-REQUIRED` value decoded: 12 KiB of JSON once decoded, which
 * stays inside the persisted observation's 32 KiB bound.
 */
export const PAYMENT_REQUIRED_HEADER_MAX_CHARS = 16_384;

/** Evidence path of the x402 v2 header envelope. */
const PAYMENT_REQUIRED_PATH = '$.headers["payment-required"]';
const WWW_AUTHENTICATE_PATH = '$.headers["www-authenticate"]';

/** The fixed claim boundary every stored challenge carries. */
export const PAYMENT_CHALLENGE_CLAIM_STATEMENT =
  'The endpoint declared a payment requirement for this request. This is not evidence that a payment was offered, authorized, made, or settled, nor that any service was delivered.' as const;

export type RetrievedResponse = {
  resource: string;
  httpStatus: number;
  /** Header names are matched case-insensitively, as HTTP requires. */
  headers: Record<string, string | undefined>;
  /**
   * Already-decoded body text, or null when no complete body was retained. A
   * caller that received only a prefix of the body passes null: a prefix is
   * never parsed as though it were the whole body.
   */
  bodyText: string | null;
  retrievedAt: string;
};

/** Exact text, or null. Numbers are stringified rather than reinterpreted. */
const exactText = (value: unknown): string | null => {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return null;
};

const headerValue = (
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    // An empty header declares nothing, so it is absent. Passing it on would
    // fail the schema's non-empty rule and throw out of the inspection.
    if (key.toLowerCase() === wanted && typeof value === 'string')
      return value || undefined;
  }
  return undefined;
};

/** Fields modelled explicitly; everything else is retained as unrecognized. */
const MODELLED_KEYS = new Set([
  'scheme',
  'network',
  'asset',
  'payTo',
  'maxAmountRequired',
  'maxTimeoutSeconds',
]);

function requirementFrom(
  entry: unknown,
  ordinal: number,
  basePath: string,
): {
  requirement?: EconomicDeclaredRequirement;
  rejection?: EconomicChallengeRejection;
  precisionWarning?: EconomicChallengeRejection;
} {
  const path = `${basePath}[${ordinal}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return {
      rejection: {
        code: 'malformed_requirement',
        detail: 'Declared requirement was not a JSON object.',
        evidencePath: path,
      },
    };
  }
  const record = entry as Record<string, unknown>;
  // x402 declares amounts as strings: `maxAmountRequired` in v1 and `amount`
  // in v2. A number here is non-conformant input and JSON numbers are IEEE
  // 754 doubles, so precision may already be gone before this code runs.
  // Record that rather than implying fidelity.
  const numericAmount = (['maxAmountRequired', 'amount'] as const).find(
    (key) => typeof record[key] === 'number',
  );
  const precisionWarning = numericAmount
    ? {
        code: 'amount_not_a_string' as const,
        detail:
          'A declared amount arrived as a JSON number rather than a string; precision may have been lost before parsing.',
        evidencePath: `${path}.${numericAmount}`,
      }
    : undefined;
  const unrecognizedFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!MODELLED_KEYS.has(key)) unrecognizedFields[key] = value;
  }
  return {
    precisionWarning,
    requirement: {
      ordinal,
      scheme: exactText(record.scheme),
      network: exactText(record.network),
      asset: exactText(record.asset),
      payTo: exactText(record.payTo),
      // `amount` and `currency` appear alongside these in observed payloads,
      // and x402 v2 names its amount `amount`. They are deliberately not
      // merged into the modelled fields: they are retained as unrecognized so
      // a later reader can see exactly what the publisher sent rather than a
      // normalization decision made here.
      maxAmountRequired: exactText(record.maxAmountRequired),
      maxTimeoutSeconds: exactText(record.maxTimeoutSeconds),
      unrecognizedFields,
      evidencePath: path,
    },
  };
}

type ParsedRequirements = {
  declaredProtocolVersion: string | null;
  requirements: EconomicDeclaredRequirement[];
  rejections: EconomicChallengeRejection[];
};

/**
 * Read an x402 `PaymentRequired` envelope carrying `accepts[]`, wherever it
 * travelled. `basePath` is the evidence path of the envelope itself: `$` for
 * the body, the header path for the v2 header.
 *
 * Duplicate entries keep their ordinals, so a publisher declaring the same
 * terms twice is recorded as having done so.
 */
function fromX402Envelope(
  parsed: unknown,
  basePath: string,
): ParsedRequirements {
  const requirements: EconomicDeclaredRequirement[] = [];
  const rejections: EconomicChallengeRejection[] = [];
  let declaredProtocolVersion: string | null = null;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    rejections.push({
      code: 'malformed_envelope',
      detail: 'The 402 body was not a JSON object.',
      evidencePath: basePath,
    });
    return { declaredProtocolVersion, requirements, rejections };
  }
  const envelope = parsed as Record<string, unknown>;
  declaredProtocolVersion = exactText(envelope.x402Version);
  const accepts = envelope.accepts;
  const acceptsPath = `${basePath}.accepts`;
  if (accepts === undefined) {
    rejections.push({
      code: 'no_requirements_declared',
      detail: 'The 402 envelope declared no accepts array.',
      evidencePath: acceptsPath,
    });
  } else if (!Array.isArray(accepts)) {
    rejections.push({
      code: 'malformed_envelope',
      detail: 'The accepts field was present but was not an array.',
      evidencePath: acceptsPath,
    });
  } else if (accepts.length === 0) {
    rejections.push({
      code: 'no_requirements_declared',
      detail: 'The 402 envelope declared an empty accepts array.',
      evidencePath: acceptsPath,
    });
  } else {
    accepts.forEach((entry, index) => {
      const { requirement, rejection, precisionWarning } = requirementFrom(
        entry,
        index,
        acceptsPath,
      );
      if (requirement) requirements.push(requirement);
      if (rejection) rejections.push(rejection);
      if (precisionWarning) rejections.push(precisionWarning);
    });
  }
  return { declaredProtocolVersion, requirements, rejections };
}

/** Parse the 402 body as an x402 envelope. */
function fromBodyText(bodyText: string | null): ParsedRequirements {
  if (bodyText === null)
    return {
      declaredProtocolVersion: null,
      requirements: [],
      rejections: [
        {
          code: 'malformed_envelope',
          detail: 'A 402 was returned but no body was retained.',
          evidencePath: '$',
        },
      ],
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      declaredProtocolVersion: null,
      requirements: [],
      rejections: [
        {
          code: 'body_not_valid_utf8_json',
          detail: 'The 402 body was not valid JSON.',
          evidencePath: '$',
        },
      ],
    };
  }
  return fromX402Envelope(parsed, '$');
}

const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode the x402 v2 `PAYMENT-REQUIRED` header: RFC 4648 base64 of UTF-8 JSON.
 * Decoding is strict: padded standard base64 only, as every example in the
 * x402 v2 HTTP transport is. A value that is not that, not UTF-8 or not a JSON
 * object is a rejection, and nothing is guessed from it.
 */
function decodePaymentRequiredHeader(
  value: string,
):
  | { ok: true; parsed: unknown }
  | { ok: false; rejection: EconomicChallengeRejection } {
  const reject = (detail: string) => ({
    ok: false as const,
    rejection: {
      code: 'malformed_envelope' as const,
      detail,
      evidencePath: PAYMENT_REQUIRED_PATH,
    },
  });
  if (value.length > PAYMENT_REQUIRED_HEADER_MAX_CHARS)
    return reject(
      `The PAYMENT-REQUIRED header exceeded ${PAYMENT_REQUIRED_HEADER_MAX_CHARS} characters and was not decoded.`,
    );
  if (!STANDARD_BASE64.test(value) || value.length % 4 !== 0)
    return reject(
      'The PAYMENT-REQUIRED header was not padded standard base64.',
    );
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value), (character) =>
      character.charCodeAt(0),
    );
  } catch {
    return reject('The PAYMENT-REQUIRED header was not standard base64.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return reject('The PAYMENT-REQUIRED header did not decode to UTF-8 text.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reject('The PAYMENT-REQUIRED header did not decode to JSON.');
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? { ok: true, parsed }
    : reject('The PAYMENT-REQUIRED header did not decode to a JSON object.');
}

/** Key-sorted JSON, so two envelopes compare by content, not key order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );

/** The declared terms of a parse, without where in the bytes they sat. */
const declaredTerms = (parsed: ParsedRequirements) =>
  canonical({
    declaredProtocolVersion: parsed.declaredProtocolVersion,
    requirements: parsed.requirements.map((requirement) => ({
      ...requirement,
      evidencePath: undefined,
    })),
  });

function x402Observation(
  response: RetrievedResponse,
  surface: 'http_402_x402_body' | 'http_402_x402_header',
  parsed: ParsedRequirements,
  rawChallengeHeader: string | null,
  extraRejections: readonly EconomicChallengeRejection[],
): EconomicPaymentChallengeObservation {
  return economicPaymentChallengeObservationSchema.parse({
    observationVersion: ECONOMIC_PAYMENT_CHALLENGE_VERSION,
    claimStatement: PAYMENT_CHALLENGE_CLAIM_STATEMENT,
    surface,
    resource: response.resource,
    httpStatus: response.httpStatus,
    retrievedAt: response.retrievedAt,
    declaredProtocolVersion: parsed.declaredProtocolVersion,
    rawChallengeHeader,
    requirements: parsed.requirements,
    rejections: [...parsed.rejections, ...extraRejections],
    settlementObserved: false,
    deliveryObserved: false,
  });
}

/**
 * Record a `WWW-Authenticate` challenge without parsing it.
 *
 * An earlier version of this function parsed the header into declared
 * requirements against a guessed grammar. Three things were wrong with that.
 * The grammar did not match the draft it claimed to be pinned to. A header
 * carrying two challenges merged the second's parameters into the first, so
 * the record asserted that a value came from somewhere it did not. And no 402
 * challenge was ever observed in the September sampling, so the whole shape
 * was conjecture.
 *
 * The header is therefore retained exactly as sent and reported as
 * unparsed. That loses no evidence and invents none. When a validated
 * grammar and an observed challenge exist, parsing can be added under a new
 * observation version.
 */
function fromWwwAuthenticate(
  response: RetrievedResponse,
  headerText: string | null,
  extraRejections: readonly EconomicChallengeRejection[],
): EconomicPaymentChallengeObservation {
  return economicPaymentChallengeObservationSchema.parse({
    observationVersion: ECONOMIC_PAYMENT_CHALLENGE_VERSION,
    claimStatement: PAYMENT_CHALLENGE_CLAIM_STATEMENT,
    surface: 'http_402_www_authenticate',
    resource: response.resource,
    httpStatus: response.httpStatus,
    retrievedAt: response.retrievedAt,
    declaredProtocolVersion: null,
    rawChallengeHeader: headerText,
    requirements: [],
    rejections: [
      // An oversize header already carries its own rejection.
      ...(headerText === null
        ? []
        : [
            {
              code: 'challenge_grammar_not_validated' as const,
              detail:
                'A WWW-Authenticate challenge was retained verbatim. No validated grammar exists for it, so it was not parsed into declared requirements.',
              evidencePath: WWW_AUTHENTICATE_PATH,
            },
          ]),
      ...extraRejections,
    ],
    settlementObserved: false,
    deliveryObserved: false,
  });
}

/**
 * Extract a payment requirement declaration from an already-retrieved
 * response, or `null` when the response is not a payment challenge at all.
 *
 * Only HTTP 402 qualifies. A 401 or 403 is an authentication or authorization
 * barrier, not a price, and is deliberately not treated as one.
 */
export function extractPaymentChallenge(
  response: RetrievedResponse,
): EconomicPaymentChallengeObservation | null {
  if (response.httpStatus !== 402) return null;

  const contentType = headerValue(response.headers, 'content-type') ?? '';
  const wwwAuthenticateHeader = headerValue(
    response.headers,
    'www-authenticate',
  );
  const paymentRequired = headerValue(response.headers, 'payment-required');
  const headerRejections: EconomicChallengeRejection[] = [];

  // A WWW-Authenticate value is kept whole or not at all.
  const wwwAuthenticate =
    wwwAuthenticateHeader !== undefined &&
    wwwAuthenticateHeader.length > PAYMENT_CHALLENGE_HEADER_MAX_CHARS
      ? null
      : (wwwAuthenticateHeader ?? null);
  if (wwwAuthenticateHeader !== undefined && wwwAuthenticate === null)
    headerRejections.push({
      code: 'challenge_header_not_retained',
      detail: `A WWW-Authenticate challenge exceeded ${PAYMENT_CHALLENGE_HEADER_MAX_CHARS} characters and was not retained.`,
      evidencePath: WWW_AUTHENTICATE_PATH,
    });
  const jsonBody = response.bodyText !== null && /json/i.test(contentType);

  // The x402 v2 header is the canonical location of the PaymentRequired
  // object, so it is read first. A header that cannot be decoded is recorded
  // as a rejection beside whatever the rest of the response yields.
  if (paymentRequired !== undefined) {
    const decoded = decodePaymentRequiredHeader(paymentRequired);
    if (decoded.ok) {
      const header = fromX402Envelope(decoded.parsed, PAYMENT_REQUIRED_PATH);
      // A v1 client reads the body, so a body declaring other terms is said,
      // not silently set aside. A body that declares nothing is not a
      // disagreement.
      const body = jsonBody ? fromBodyText(response.bodyText) : null;
      if (
        body?.requirements.length &&
        declaredTerms(body) !== declaredTerms(header)
      )
        headerRejections.push({
          code: 'body_differs_from_header',
          detail:
            'The 402 body declared different payment requirements from the PAYMENT-REQUIRED header. The header, the canonical location, was recorded.',
          evidencePath: '$',
        });
      return x402Observation(
        response,
        'http_402_x402_header',
        header,
        wwwAuthenticate,
        headerRejections,
      );
    }
    headerRejections.push(decoded.rejection);
  }

  // A JSON body is the richer surface, so prefer it to the challenge header.
  // Both are recorded with the surface that produced them, so the evidence
  // never claims to come from somewhere it did not.
  if (jsonBody) {
    // The challenge header travels with the observation either way, so a
    // body that fails to parse cannot cause a challenge to be silently dropped.
    return x402Observation(
      response,
      'http_402_x402_body',
      fromBodyText(response.bodyText),
      wwwAuthenticate,
      headerRejections,
    );
  }
  if (wwwAuthenticateHeader !== undefined) {
    return fromWwwAuthenticate(response, wwwAuthenticate, headerRejections);
  }
  return x402Observation(
    response,
    'http_402_x402_body',
    fromBodyText(response.bodyText),
    null,
    headerRejections,
  );
}
