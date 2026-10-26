import { z } from 'zod';

/**
 * Publisher-native payment requirement observation.
 *
 * Scope note: only an HTTP 402 x402 envelope is parsed into declared
 * requirements, from the JSON body or, from extractor v2, the x402 v2
 * `PAYMENT-REQUIRED` header. OpenAPI `x-payment-info` is not modelled here: v1 carried a
 * root-level reader that did not match draft-payment-discovery-01, and v2
 * removes it. Passport inspection reads the per-operation extension instead.
 *
 * A `WWW-Authenticate` challenge is retained verbatim but deliberately not
 * parsed. No 402 challenge was observed in the September sampling — every
 * retained response was a 200 or a 404 — so any grammar implemented here
 * would be conjecture, and a versioned contract is an expensive place to
 * record a guess. The header is preserved so nothing is lost when a
 * validated grammar arrives.
 *
 * A catalog listing is a third party's description of what a service charges.
 * A `402 Payment Required` challenge is the service stating its own terms, for
 * this request, at this moment. They are different evidence classes and are
 * deliberately not merged: the retained September evidence shows a catalog
 * carrying a fixed `accepts[]` while the service's own description declared
 * two different prices chosen per request mode. Only the challenge is
 * authoritative for what a given call would actually cost.
 *
 * This surface is also why the track exists at all. These bytes come from the
 * publisher's own endpoint, which InterfaceDelta already fetches during
 * Passport inspection, so observing them raises no third-party catalog terms
 * question.
 *
 * Everything here describes a *declaration*. A challenge proves that an
 * endpoint asked for payment. It does not prove that anyone paid, that a
 * payment settled, that a service was delivered, or that any work was done.
 */

export const ECONOMIC_PAYMENT_CHALLENGE_VERSION =
  'economic-payment-challenge-v2' as const;

/**
 * Where the declaration was found. Each is a different evidence strength.
 *
 * `http_402_x402_header` is additive within this contract version: only
 * extractor v2 produces it, so a store must accept it before code that
 * writes it is deployed.
 */
export const ECONOMIC_DECLARATION_SURFACES = [
  /** HTTP 402 body carrying an x402 `accepts[]` envelope. */
  'http_402_x402_body',
  /**
   * The x402 v2 `PAYMENT-REQUIRED` header: a base64-encoded `PaymentRequired`
   * envelope, the transport's canonical location. Only the decoded envelope
   * is kept; the header's bytes are not hashed.
   */
  'http_402_x402_header',
  /** HTTP 402 `WWW-Authenticate: Payment` challenge header. */
  'http_402_www_authenticate',
] as const;
export const economicDeclarationSurfaceSchema = z.enum(
  ECONOMIC_DECLARATION_SURFACES,
);
export type EconomicDeclarationSurface = z.infer<
  typeof economicDeclarationSurfaceSchema
>;

/**
 * One declared payment requirement, kept exactly as the publisher wrote it.
 *
 * Amounts stay text. They are arbitrary-precision atomic units in an unknown
 * asset's decimals, and parsing one into a number would silently lose
 * precision and invent a currency interpretation nobody stated.
 */
export const economicDeclaredRequirementSchema = z
  .object({
    /** Position in the publisher's list. Duplicates keep their multiplicity. */
    ordinal: z.number().int().nonnegative(),
    scheme: z.string().min(1).nullable(),
    network: z.string().min(1).nullable(),
    asset: z.string().min(1).nullable(),
    payTo: z.string().min(1).nullable(),
    /** Exact text. Never parsed into a number, never rescaled. */
    maxAmountRequired: z.string().min(1).nullable(),
    maxTimeoutSeconds: z.string().min(1).nullable(),
    /** Publisher fields we do not model, retained verbatim for provenance. */
    unrecognizedFields: z.record(z.unknown()),
    /** Exact path within the retained bytes that produced this row. */
    evidencePath: z.string().min(1),
  })
  .strict();
export type EconomicDeclaredRequirement = z.infer<
  typeof economicDeclaredRequirementSchema
>;

export const ECONOMIC_CHALLENGE_REJECTION_CODES = [
  'malformed_envelope',
  'malformed_requirement',
  'no_requirements_declared',
  'body_not_valid_utf8_json',
  /**
   * A `WWW-Authenticate` challenge was present and has been retained
   * verbatim, but no validated grammar exists to parse it into declared
   * requirements. Parsing it would mean guessing.
   */
  'challenge_grammar_not_validated',
  /**
   * A modelled amount arrived as a JSON number rather than a string. JSON
   * numbers are IEEE 754 doubles, so the value may already have lost
   * precision before it reached this code.
   */
  'amount_not_a_string',
  /**
   * A `WWW-Authenticate` challenge exceeded the extractor's bound and was not
   * retained. It is never cut, so a retained header is always whole.
   * Additive within this contract version; extractor v2 only.
   */
  'challenge_header_not_retained',
  /**
   * Both the `PAYMENT-REQUIRED` header and the body carried an x402 envelope
   * and they declared different requirements. The header, the canonical
   * location, was recorded. Additive within this contract version; extractor
   * v2 only.
   */
  'body_differs_from_header',
] as const;
export const economicChallengeRejectionSchema = z
  .object({
    code: z.enum(ECONOMIC_CHALLENGE_REJECTION_CODES),
    detail: z.string().min(1),
    evidencePath: z.string().min(1),
  })
  .strict();
export type EconomicChallengeRejection = z.infer<
  typeof economicChallengeRejectionSchema
>;

export const economicPaymentChallengeObservationSchema = z
  .object({
    observationVersion: z.literal(ECONOMIC_PAYMENT_CHALLENGE_VERSION),
    /**
     * Fixed wording. A challenge is a demand, not a transaction, and the
     * distinction has to travel with the record.
     */
    claimStatement: z.literal(
      'The endpoint declared a payment requirement for this request. This is not evidence that a payment was offered, authorized, made, or settled, nor that any service was delivered.',
    ),

    surface: economicDeclarationSurfaceSchema,
    /** The exact endpoint whose response this is. */
    resource: z.string().min(1),
    httpStatus: z.number().int(),
    retrievedAt: z.string().min(1),

    /** Protocol version the publisher stated, verbatim, if any. */
    declaredProtocolVersion: z.string().min(1).nullable(),

    /**
     * The exact `WWW-Authenticate` header, when one was present, retained
     * whether or not this observation's requirements came from it. A body
     * that fails to parse must not cause a challenge header to be lost.
     */
    rawChallengeHeader: z.string().min(1).nullable(),

    requirements: z.array(economicDeclaredRequirementSchema),
    rejections: z.array(economicChallengeRejectionSchema),

    /**
     * Declared-only. The catalog equivalent of these fields is a third
     * party's claim; this one is the publisher's. Neither is a settlement.
     */
    settlementObserved: z.literal(false),
    deliveryObserved: z.literal(false),
  })
  .strict()
  .superRefine((o, ctx) => {
    // A challenge that declared nothing usable must say so rather than
    // presenting as an empty but successful observation.
    if (o.requirements.length === 0 && o.rejections.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'An observation with no declared requirements must carry a rejection explaining why.',
        path: ['rejections'],
      });
    }
    // Only a 402 is a payment challenge.
    if (o.httpStatus !== 402) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A challenge surface requires HTTP 402; any other status is not a payment challenge.',
        path: ['httpStatus'],
      });
    }
  });
export type EconomicPaymentChallengeObservation = z.infer<
  typeof economicPaymentChallengeObservationSchema
>;
