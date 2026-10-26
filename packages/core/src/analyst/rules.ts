/**
 * decision-card-rules-v1.
 * Pure tables over the namespaced code and classification the compatibility
 * and payment-terms rules already assigned. Nothing here upgrades or
 * downgrades a classification, and no model sets any of these values.
 */
export const DECISION_CARD_VERSION = 'decision-card-v1' as const;
export const DECISION_CARD_RULES_VERSION = 'decision-card-rules-v1' as const;

export type CodeNamespace = 'compatibility' | 'payment_terms';
export type Classification =
  'breaking' | 'indeterminate' | 'non_breaking' | 'informational';
export type Attention = 'review_first' | 'review' | 'for_the_record';
export type Domain = 'product' | 'security_compliance' | 'finance';

export const ATTENTION_ORDER: readonly Attention[] = [
  'review_first',
  'review',
  'for_the_record',
];
export const CLASSIFICATION_ORDER: readonly Classification[] = [
  'breaking',
  'indeterminate',
  'non_breaking',
  'informational',
];

export type RuleEvent = {
  namespace: CodeNamespace;
  code: string;
  classification: string;
  /** Workflow relevance named a dependency this event concerns. */
  matched: boolean;
  /** Relevance notes on the match, such as LISTED_SUBSTITUTE_DECLARED_PRESENT. */
  notes: readonly string[];
};

/**
 * The compatibility codes the rules name (§4.2). The coverage test fails when
 * drift.ts emits a code missing here, so the table cannot fall behind it.
 */
export const COMPATIBILITY_CODES = [
  'ACCESS_BECAME_PUBLICLY_OBSERVABLE',
  'ACCESS_METADATA_CHANGED',
  'ACCESS_NOW_FORBIDDEN',
  'ACCESS_NOW_REQUIRES_AUTH',
  'ACCESS_NOW_REQUIRES_PAYMENT',
  'CAPABILITY_ADDED',
  'CAPABILITY_METADATA_CHANGED',
  'CAPABILITY_REMOVED',
  'CONSISTENCY_FINDING_CHANGED',
  'ENDPOINT_ADDED',
  'ENDPOINT_OBSERVATION_FAILED',
  'ENDPOINT_OBSERVATION_STATE_CHANGED',
  'ENDPOINT_REMOVED',
  'IDENTITY_ASSERTION_CHANGED',
  'INVENTORY_COMPARISON_INDETERMINATE',
  'MCP_TOOL_INPUT_SCHEMA_CHANGED',
  'MCP_TOOL_OUTPUT_SCHEMA_CHANGED',
  'OPENAPI_OPERATION_ADDED',
  'OPENAPI_OPERATION_ID_CHANGED',
  'OPENAPI_OPERATION_NOW_REQUIRES_PAYMENT',
  'OPENAPI_OPERATION_NO_LONGER_REQUIRES_PAYMENT',
  'OPENAPI_OPERATION_REMOVED',
  'OPENAPI_PARAMETER_ADDED',
  'OPENAPI_PARAMETER_REMOVED',
  'OPENAPI_PARAMETER_REQUIREDNESS_CHANGED',
  'OPENAPI_PARAMETER_SCHEMA_CHANGED',
  'OPENAPI_PAYMENT_DECLARATION_CHANGED',
  'OPENAPI_PAYMENT_DECLARATION_COVERAGE_CHANGED',
  'OPENAPI_REQUEST_BODY_REQUIREDNESS_CHANGED',
  'OPENAPI_REQUEST_SCHEMA_CHANGED',
  'OPENAPI_RESPONSE_SCHEMA_CHANGED',
  'OPENAPI_RESPONSE_SET_CHANGED',
  'OPENAPI_SURFACE_ADDED',
  'OPENAPI_SURFACE_REMOVED',
  'PROTOCOL_OBSERVATION_FAILED',
  'PROTOCOL_SURFACE_ADDED',
  'PROTOCOL_SURFACE_REMOVED',
  'PROTOCOL_VERSION_CHANGED',
  'UNCLASSIFIED_SEMANTIC_CHANGE',
  'WEBMCP_DECLARATIONS_NOT_OBSERVED',
  'WEBMCP_DECLARATIONS_OBSERVED',
  'WEBMCP_TOOL_CONTROLS_CHANGED',
] as const;

export const ACTION_CODES = [
  'CHECK_LISTED_SUBSTITUTE',
  'FIND_REPLACEMENT_OR_RELINK',
  'UPDATE_CLIENT_INPUTS',
  'CHECK_INPUT_SCHEMA',
  'CHECK_RESPONSE_HANDLING',
  'CONFIRM_ACCESS',
  'CONFIRM_PAYMENT_TERMS',
  'VERIFY_PAYEE_OUT_OF_BAND',
  'CHECK_PROTOCOL_REVISION',
  'REOBSERVE_BEFORE_ACTING',
  'REVIEW_ADDITION',
  'REVIEW_CHANGE',
  'NO_ACTION_SUGGESTED',
] as const;
export type ActionCode = (typeof ACTION_CODES)[number];

/** The suggested step and the check that goes with it (§4.2, §4.3). */
export const ACTION_COPY: Readonly<
  Record<ActionCode, { text: string; check: string }>
> = {
  CHECK_LISTED_SUBSTITUTE: {
    text: 'Confirm your client can use the substitute you listed.',
    check:
      'Inspect the service again and confirm the substitute is still declared.',
  },
  FIND_REPLACEMENT_OR_RELINK: {
    text: 'Find a replacement, or re-link the dependency in your workflow if it was renamed.',
    check:
      'Inspect the service and confirm the element is absent from a complete inventory.',
  },
  UPDATE_CLIENT_INPUTS: {
    text: 'Compare the new input requirements with what your client sends.',
    check:
      'Compare the recorded input schema with a request your client makes today.',
  },
  CHECK_INPUT_SCHEMA: {
    text: 'The rules could not prove compatibility. Check the input schema against your calls.',
    check:
      'Compare the before and after schemas in the technical details below.',
  },
  CHECK_RESPONSE_HANDLING: {
    text: 'Check that your client still parses the response.',
    check:
      'Run your client against the service and check how it handles the response.',
  },
  CONFIRM_ACCESS: {
    text: 'Confirm you hold valid credentials or access for this endpoint.',
    check:
      'Call the endpoint with the credentials your client uses and record the status.',
  },
  CONFIRM_PAYMENT_TERMS: {
    text: 'Confirm the declared payment terms with the provider before relying on them.',
    check:
      'Compare the declared terms with what the provider has agreed with you.',
  },
  VERIFY_PAYEE_OUT_OF_BAND: {
    text: 'Verify the new payee through a channel you already trust before any payment.',
    check:
      'Ask the provider, through a contact you already hold, to confirm the payee address.',
  },
  CHECK_PROTOCOL_REVISION: {
    text: 'Confirm your client supports the protocol revision now negotiated or declared.',
    check: 'Check which protocol revisions your client library supports.',
  },
  REOBSERVE_BEFORE_ACTING: {
    text: 'The evidence is incomplete. Run an inspection, or wait for the next scan, before acting.',
    check: 'Inspect the service again and compare a complete observation.',
  },
  REVIEW_ADDITION: {
    text: 'Optional: review whether the addition is useful to you.',
    check: 'Read the added element in the current Passport.',
  },
  REVIEW_CHANGE: {
    text: 'Read the change and decide whether your client depends on it.',
    check: 'Compare the before and after values in the technical details.',
  },
  NO_ACTION_SUGGESTED: {
    text: 'No step suggested. Monitoring continues.',
    check: 'Later observations will show any further change.',
  },
};

const set = (...values: string[]) => new Set(values);

const REMOVALS_WITH_SUBSTITUTE = set('CAPABILITY_REMOVED', 'ENDPOINT_REMOVED');
const REMOVALS = set(
  'CAPABILITY_REMOVED',
  'ENDPOINT_REMOVED',
  'OPENAPI_OPERATION_REMOVED',
  'PROTOCOL_SURFACE_REMOVED',
  'OPENAPI_SURFACE_REMOVED',
);
const BREAKING_INPUTS = set(
  'OPENAPI_PARAMETER_ADDED',
  'OPENAPI_PARAMETER_REQUIREDNESS_CHANGED',
  'OPENAPI_REQUEST_BODY_REQUIREDNESS_CHANGED',
  'OPENAPI_REQUEST_SCHEMA_CHANGED',
  'OPENAPI_PARAMETER_SCHEMA_CHANGED',
  'MCP_TOOL_INPUT_SCHEMA_CHANGED',
);
const UNPROVEN_INPUTS = set(
  'OPENAPI_PARAMETER_REMOVED',
  'OPENAPI_REQUEST_SCHEMA_CHANGED',
  'OPENAPI_PARAMETER_SCHEMA_CHANGED',
  'MCP_TOOL_INPUT_SCHEMA_CHANGED',
);
const RESPONSES = set(
  'MCP_TOOL_OUTPUT_SCHEMA_CHANGED',
  'OPENAPI_RESPONSE_SCHEMA_CHANGED',
  'OPENAPI_RESPONSE_SET_CHANGED',
);
const ACCESS = set(
  'ACCESS_NOW_REQUIRES_AUTH',
  'ACCESS_NOW_FORBIDDEN',
  'ACCESS_METADATA_CHANGED',
);
const PAYMENT = set(
  'ACCESS_NOW_REQUIRES_PAYMENT',
  'OPENAPI_OPERATION_NOW_REQUIRES_PAYMENT',
  'OPENAPI_PAYMENT_DECLARATION_CHANGED',
);
const REOBSERVE = set(
  'INVENTORY_COMPARISON_INDETERMINATE',
  'ENDPOINT_OBSERVATION_FAILED',
  'PROTOCOL_OBSERVATION_FAILED',
  'ENDPOINT_OBSERVATION_STATE_CHANGED',
  'UNCLASSIFIED_SEMANTIC_CHANGE',
  'WEBMCP_DECLARATIONS_NOT_OBSERVED',
);
const ADDITIONS = set(
  'CAPABILITY_ADDED',
  'ENDPOINT_ADDED',
  'OPENAPI_OPERATION_ADDED',
  'OPENAPI_PARAMETER_ADDED',
  'PROTOCOL_SURFACE_ADDED',
  'OPENAPI_SURFACE_ADDED',
  'WEBMCP_DECLARATIONS_OBSERVED',
);
const PAYEE = set('PAYEE_CHANGED', 'PAYEE_ADDED');
const PAYMENT_TERMS_BADGE = set(
  'NETWORK_CHANGED',
  'ASSET_CHANGED',
  'SCHEME_CHANGED',
  'PAYMENT_OPTION_REMOVED',
);

const isAttentionClass = (value: string): value is Classification =>
  (CLASSIFICATION_ORDER as readonly string[]).includes(value);

/** §4.2: one action for one event. Total: every input reaches exactly one. */
export function actionFor(
  event: RuleEvent,
  comparisonState: string | null,
): ActionCode {
  if (comparisonState === 'incompatible_version')
    return 'REOBSERVE_BEFORE_ACTING';
  const { code, classification } = event;
  if (event.namespace === 'payment_terms') {
    if (PAYEE.has(code)) return 'VERIFY_PAYEE_OUT_OF_BAND';
    if (PAYMENT_TERMS_BADGE.has(code)) return 'CONFIRM_PAYMENT_TERMS';
    if (code === 'PAYMENT_OPTION_ADDED') return 'REVIEW_ADDITION';
    return 'NO_ACTION_SUGGESTED';
  }
  if (REMOVALS_WITH_SUBSTITUTE.has(code) && event.matched)
    if (event.notes.includes('LISTED_SUBSTITUTE_DECLARED_PRESENT'))
      return 'CHECK_LISTED_SUBSTITUTE';
  if (REMOVALS.has(code)) return 'FIND_REPLACEMENT_OR_RELINK';
  if (classification === 'breaking' && BREAKING_INPUTS.has(code))
    return 'UPDATE_CLIENT_INPUTS';
  if (classification === 'indeterminate' && UNPROVEN_INPUTS.has(code))
    return 'CHECK_INPUT_SCHEMA';
  if (
    (classification === 'breaking' || classification === 'indeterminate') &&
    RESPONSES.has(code)
  )
    return 'CHECK_RESPONSE_HANDLING';
  if (ACCESS.has(code)) return 'CONFIRM_ACCESS';
  if (PAYMENT.has(code)) return 'CONFIRM_PAYMENT_TERMS';
  if (code === 'PROTOCOL_VERSION_CHANGED') return 'CHECK_PROTOCOL_REVISION';
  if (REOBSERVE.has(code)) return 'REOBSERVE_BEFORE_ACTING';
  if (classification === 'non_breaking' && ADDITIONS.has(code))
    return 'REVIEW_ADDITION';
  if (classification === 'breaking' || classification === 'indeterminate')
    return 'REVIEW_CHANGE';
  // Not one of the four classes: never read as calm.
  if (!isAttentionClass(classification)) return 'REVIEW_CHANGE';
  return 'NO_ACTION_SUGGESTED';
}

/**
 * §4.1: attention for one event. `strict` is the matched column: a matched
 * event, relevance not computed, or a named dependency not evaluable.
 */
export function attentionFor(
  event: RuleEvent,
  strict: boolean,
  comparisonState: string | null,
): Attention {
  if (event.namespace === 'payment_terms') {
    if (PAYEE.has(event.code)) return 'review_first';
    if (PAYMENT_TERMS_BADGE.has(event.code)) return 'review';
    if (event.code === 'PAYMENT_OPTION_ADDED')
      return strict ? 'review' : 'for_the_record';
    return 'for_the_record';
  }
  if (event.classification === 'breaking')
    return strict ? 'review_first' : 'review';
  if (
    event.classification === 'indeterminate' ||
    comparisonState === 'incompatible_version'
  )
    return 'review';
  if (event.classification === 'non_breaking')
    return strict ? 'review' : 'for_the_record';
  if (event.classification === 'informational') return 'for_the_record';
  // An unknown class is reviewed, never filed away.
  return 'review';
}

const FINANCE = set(
  'ACCESS_NOW_REQUIRES_PAYMENT',
  'OPENAPI_OPERATION_NOW_REQUIRES_PAYMENT',
  'OPENAPI_OPERATION_NO_LONGER_REQUIRES_PAYMENT',
  'OPENAPI_PAYMENT_DECLARATION_CHANGED',
  'OPENAPI_PAYMENT_DECLARATION_COVERAGE_CHANGED',
);
const SECURITY = set(
  'ACCESS_NOW_REQUIRES_AUTH',
  'ACCESS_NOW_FORBIDDEN',
  'ACCESS_BECAME_PUBLICLY_OBSERVABLE',
  'ACCESS_METADATA_CHANGED',
  'IDENTITY_ASSERTION_CHANGED',
  'CONSISTENCY_FINDING_CHANGED',
);

/** §4.4: who may want to read the card. A routing hint, not a consequence. */
export function domainsFor(event: RuleEvent): Domain[] {
  const domains = new Set<Domain>();
  if (event.namespace === 'payment_terms') {
    domains.add('finance');
    if (PAYEE.has(event.code)) domains.add('security_compliance');
  } else {
    if (FINANCE.has(event.code)) domains.add('finance');
    if (SECURITY.has(event.code)) domains.add('security_compliance');
    if (
      (!FINANCE.has(event.code) && !SECURITY.has(event.code)) ||
      event.classification === 'breaking'
    )
      domains.add('product');
  }
  return (['product', 'security_compliance', 'finance'] as const).filter(
    (domain) => domains.has(domain),
  );
}

export const rankOf = <T>(order: readonly T[], value: T) => {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
};

/** Words InterfaceDelta never writes on a card (§3); quoted values are exempt. */
export const DECISION_CARD_BANNED_WORDS = [
  'affected',
  'exposed',
  'safe',
  'unaffected',
  'risk score',
  'likely',
  'probability',
] as const;
