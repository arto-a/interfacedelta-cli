import { stripBidiControls } from '@interfacedelta/common/display-text';

export type ChangeDetailInput = {
  readonly code: string;
  readonly reasonCode?: string;
  readonly path?: string;
  readonly entityId: string;
  readonly before?: unknown;
  readonly after?: unknown;
};

const MAX_DETAIL = 240;
const MAX_LIST = 5;

// Remote values are quoted here, so bidi controls are removed before display.
const clip = (input: string, maximum = 80): string => {
  const text = stripBidiControls(input);
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
};
const quote = (text: string): string => `“${clip(text)}”`;
const word = (text: string): string => text.replaceAll('_', ' ');
const sentence = (text: string): string =>
  clip(text.charAt(0).toUpperCase() + text.slice(1), MAX_DETAIL);

function value(input: unknown): string {
  if (input === null || input === undefined) return 'none';
  if (typeof input === 'string') return quote(input);
  if (typeof input === 'number' || typeof input === 'boolean')
    return String(input);
  return clip(JSON.stringify(input));
}

const stringList = (input: unknown): string[] | undefined =>
  Array.isArray(input) && input.every((item) => typeof item === 'string')
    ? (input as string[])
    : undefined;

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LIST).join(', ');
  return items.length > MAX_LIST
    ? `${shown} and ${items.length - MAX_LIST} more`
    : shown;
}

const shortHash = (input: unknown): string | undefined =>
  typeof input === 'string' && /^[0-9a-f]{12,}$/.test(input)
    ? `${input.slice(0, 12)}…`
    : undefined;

type Pointer = { readonly field?: string; readonly keyword?: string };

function pointer(path: string | undefined): Pointer | undefined {
  if (path === undefined || (path !== '$' && !path.startsWith('$/')))
    return undefined;
  const parts =
    path === '$'
      ? []
      : path
          .slice(2)
          .split('/')
          .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let field = '';
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part === 'properties' && index + 1 < parts.length) {
      const name = parts[++index]!;
      field = field ? `${field}.${name}` : name;
    } else if (part === 'items') field = `${field}[]`;
    else if (index === parts.length - 1)
      return { field: field || undefined, keyword: part };
    else return undefined;
  }
  return { field: field || undefined };
}

const location = (field: string | undefined): string =>
  field ? quote(field) : 'the top-level value';

const BOUND_LABELS: Record<string, string> = {
  minimum: 'lower bound',
  maximum: 'upper bound',
  minLength: 'minimum length',
  maxLength: 'maximum length',
  minItems: 'minimum item count',
  maxItems: 'maximum item count',
};

function enumDetail(at: string, change: ChangeDetailInput): string {
  const narrowed = change.reasonCode === 'ENUM_NARROWED';
  if (change.before === null && Array.isArray(change.after))
    return `Values for ${at} are now limited to ${change.after.length} allowed value${change.after.length === 1 ? '' : 's'}.`;
  if (Array.isArray(change.before) && change.after === null)
    return `Values for ${at} are no longer limited to a fixed set.`;
  if (Array.isArray(change.before) && Array.isArray(change.after)) {
    const key = (item: unknown) => JSON.stringify(item);
    const before = new Set(change.before.map(key));
    const after = new Set(change.after.map(key));
    const removed = [...before].filter((item) => !after.has(item)).sort();
    const added = [...after].filter((item) => !before.has(item)).sort();
    const parts = [
      removed.length
        ? `removed ${listed(removed.map((item) => clip(item, 40)))}`
        : '',
      added.length
        ? `added ${listed(added.map((item) => clip(item, 40)))}`
        : '',
    ].filter(Boolean);
    if (parts.length)
      return `Allowed values for ${at} changed: ${parts.join('; ')}.`;
  }
  return `Allowed values for ${at} were ${narrowed ? 'narrowed' : 'widened'}.`;
}

function schemaDetail(change: ChangeDetailInput): string | undefined {
  const at = pointer(change.path);
  if (!at) return undefined;
  const here = location(at.field);
  switch (change.reasonCode) {
    case 'REQUIRED_PROPERTY_ADDED':
      return at.keyword || !at.field
        ? undefined
        : `${here} is now required; before, it could be omitted.`;
    case 'REQUIRED_PROPERTY_REMOVED':
      return at.keyword || !at.field
        ? undefined
        : `${here} is no longer required and may now be omitted.`;
    case 'TYPE_SET_RESTRICTED':
    case 'TYPE_SET_RELAXED': {
      const before = stringList(change.before),
        after = stringList(change.after);
      return before && after
        ? `Permitted types for ${here} changed from ${before.join(' or ')} to ${after.join(' or ')}.`
        : `Permitted types for ${here} were ${change.reasonCode === 'TYPE_SET_RESTRICTED' ? 'narrowed' : 'widened'}.`;
    }
    case 'ENUM_NARROWED':
    case 'ENUM_WIDENED':
      return enumDetail(here, change);
    case 'LOWER_BOUND_RAISED':
    case 'LOWER_BOUND_LOWERED':
    case 'UPPER_BOUND_RAISED':
    case 'UPPER_BOUND_LOWERED':
    case 'MIN_LENGTH_RAISED':
    case 'MIN_LENGTH_LOWERED':
    case 'MAX_LENGTH_RAISED':
    case 'MAX_LENGTH_LOWERED':
    case 'MIN_ITEMS_RAISED':
    case 'MIN_ITEMS_LOWERED':
    case 'MAX_ITEMS_RAISED':
    case 'MAX_ITEMS_LOWERED': {
      const label = at.keyword ? BOUND_LABELS[at.keyword] : undefined;
      if (!label) return undefined;
      const numeric = (input: unknown) =>
        input === null || typeof input === 'number';
      return 'before' in change &&
        'after' in change &&
        numeric(change.before) &&
        numeric(change.after)
        ? `The ${label} for ${here} changed from ${value(change.before)} to ${value(change.after)}.`
        : /^(MAX_|UPPER_BOUND_)/.test(change.reasonCode)
          ? // The analyzer scores an absent upper bound as -Infinity, so "raised" can mean one was added.
            `The ${label} for ${here} changed.`
          : `The ${label} for ${here} was ${change.reasonCode.endsWith('RAISED') ? 'raised' : 'lowered'}.`;
    }
    case 'ADDITIONAL_PROPERTIES_RESTRICTED':
    case 'ADDITIONAL_PROPERTIES_RELAXED':
      if (change.after === false)
        return `${here} no longer accepts undeclared properties.`;
      if (change.before === false && change.after === true)
        return `${here} now accepts undeclared properties.`;
      return `The rule for undeclared properties of ${here} was ${change.reasonCode === 'ADDITIONAL_PROPERTIES_RESTRICTED' ? 'restricted' : 'relaxed'}.`;
    case 'PROPERTY_SCHEMA_RESTRICTED':
    case 'PROPERTY_SCHEMA_RELAXED':
      if (at.keyword || !at.field) return undefined;
      if (
        change.before === true &&
        change.after !== true &&
        change.after !== false
      )
        return `${here} now has its own schema; before, any value was accepted there.`;
      if (
        change.after === true &&
        change.before !== true &&
        change.before !== false
      )
        return `${here} now accepts any value; before, it had its own schema.`;
      if (change.after === false) return `${here} is no longer accepted.`;
      if (change.before === false)
        return `${here} is now accepted; before, it was rejected.`;
      return undefined;
    case 'UNSUPPORTED_SCHEMA_KEYWORD':
      return at.keyword
        ? `${here} uses the keyword ${quote(at.keyword)}, which the deterministic analyzer does not model.`
        : undefined;
    case 'REMOTE_REF_NOT_RESOLVED':
      return typeof change.after === 'string'
        ? `${here} references the remote schema ${quote(change.after)}, which InterfaceDelta does not fetch.`
        : `${here} references a remote schema, which InterfaceDelta does not fetch.`;
    case 'LOCAL_REF_INVALID':
      return `${here} has a local reference that could not be resolved.`;
    case 'LOCAL_REF_CYCLE':
      return `${here} has a local reference that forms a cycle.`;
    case 'INVALID_SCHEMA_SHAPE':
      return typeof change.after === 'string'
        ? `${here} is not a valid schema: ${clip(change.after)}.`
        : `${here} is not a valid schema.`;
    case 'SCHEMA_ANALYSIS_LIMIT_REACHED':
      return typeof change.after === 'string'
        ? `Analysis stopped at a configured bound: ${clip(change.after)}.`
        : 'Analysis stopped at a configured bound.';
    case 'UNSUPPORTED_SCHEMA_DIALECT':
      return typeof change.after === 'string'
        ? `The schema declares the unsupported dialect ${quote(change.after)}.`
        : 'The schema declares an unsupported dialect.';
    default:
      return undefined;
  }
}

function fingerprintDetail(change: ChangeDetailInput): string | undefined {
  if (!('before' in change) || !('after' in change)) return undefined;
  const before = shortHash(change.before),
    after = shortHash(change.after);
  const proven = change.reasonCode === 'SCHEMA_DIRECTIONAL_CONTAINMENT_PROVEN';
  if (before && after)
    return proven
      ? `The schema fingerprint changed from ${before} to ${after}, and the change was proven compatible in this direction.`
      : `The schema fingerprint changed from ${before} to ${after}. A bounded schema projection was not retained for both observations, so the specific fields cannot be named.`;
  if (proven) return undefined;
  if (
    !before &&
    after &&
    (change.before === null || change.before === undefined)
  )
    return 'A schema is now declared where none was recorded before.';
  if (before && !after && (change.after === null || change.after === undefined))
    return 'The previously recorded schema is no longer declared.';
  return undefined;
}

function metadataDetail(change: ChangeDetailInput): string | undefined {
  const record = (input: unknown) =>
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const before = record(change.before),
    after = record(change.after);
  if (!before || !after) return undefined;
  const parts: string[] = [];
  for (const field of ['name', 'title', 'description'] as const) {
    const a = before[field] ?? null,
      b = after[field] ?? null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a === null) parts.push(`${field} added`);
    else if (b === null) parts.push(`${field} removed`);
    else if (
      field !== 'description' &&
      typeof a === 'string' &&
      typeof b === 'string'
    )
      parts.push(`${field} changed from ${quote(a)} to ${quote(b)}`);
    else parts.push(`${field} changed`);
  }
  const beforeMeta = record(before.metadata) ?? {},
    afterMeta = record(after.metadata) ?? {};
  const keys = [
    ...new Set([...Object.keys(beforeMeta), ...Object.keys(afterMeta)]),
  ]
    .filter(
      (key) =>
        JSON.stringify(beforeMeta[key] ?? null) !==
        JSON.stringify(afterMeta[key] ?? null),
    )
    .sort();
  if (keys.length)
    parts.push(
      `metadata ${keys.length === 1 ? 'field' : 'fields'} ${listed(keys.map(quote))} changed`,
    );
  return parts.length ? sentence(`${parts.join('; ')}.`) : undefined;
}

const PARAMETER_LOCATIONS: Record<string, string> = {
  path: 'Path',
  query: 'Query',
  header: 'Header',
  cookie: 'Cookie',
};

function parameterLabel(change: ChangeDetailInput): string | undefined {
  const after =
    change.after !== null && typeof change.after === 'object'
      ? (change.after as Record<string, unknown>)
      : undefined;
  const key =
    typeof after?.key === 'string'
      ? after.key
      : change.entityId.split(' ').at(-1);
  const match = key ? /^([a-z]+):(.+)$/.exec(key) : null;
  if (!match) return undefined;
  const kind = PARAMETER_LOCATIONS[match[1]!];
  return kind ? `${kind} parameter ${quote(match[2]!)}` : undefined;
}

const lastToken = (entityId: string): string | undefined =>
  entityId.includes(' ') ? entityId.split(' ').at(-1) : undefined;

function openApiDetail(change: ChangeDetailInput): string | undefined {
  switch (change.reasonCode) {
    case 'NEW_REQUIRED_INPUT_PARAMETER':
    case 'NEW_OPTIONAL_INPUT_PARAMETER': {
      const label = parameterLabel(change);
      return label
        ? `${label} was added as ${change.reasonCode === 'NEW_REQUIRED_INPUT_PARAMETER' ? 'required' : 'optional'}.`
        : undefined;
    }
    case 'OPTIONAL_PARAMETER_BECAME_REQUIRED':
    case 'REQUIRED_PARAMETER_BECAME_OPTIONAL': {
      const label = parameterLabel(change);
      const required =
        change.reasonCode === 'OPTIONAL_PARAMETER_BECAME_REQUIRED';
      return label
        ? `${label} changed from ${required ? 'optional to required' : 'required to optional'}.`
        : undefined;
    }
    case 'REMOVED_PARAMETER_ACCEPTANCE_NOT_PROVEN': {
      const label = parameterLabel(change);
      return label ? `${label} is no longer declared.` : undefined;
    }
    case 'OPTIONAL_REQUEST_BODY_BECAME_REQUIRED':
      return 'The request body changed from optional to required.';
    case 'REQUIRED_REQUEST_BODY_BECAME_OPTIONAL':
      return 'The request body changed from required to optional.';
    case 'REQUEST_MEDIA_TYPE_ADDED': {
      const media =
        typeof change.after === 'string'
          ? change.after
          : lastToken(change.entityId);
      return media
        ? `Request media type ${quote(media)} is now declared.`
        : undefined;
    }
    case 'REQUEST_MEDIA_TYPE_REMOVED':
    case 'RESPONSE_MEDIA_TYPE_REMOVAL_NOT_PROVEN': {
      const media = lastToken(change.entityId);
      const side =
        change.reasonCode === 'REQUEST_MEDIA_TYPE_REMOVED'
          ? 'Request'
          : 'Response';
      return media
        ? `${side} media type ${quote(media)} is no longer declared.`
        : undefined;
    }
    case 'RESPONSE_STATUS_REMOVAL_COMPATIBILITY_NOT_PROVEN': {
      const status =
        typeof change.before === 'string'
          ? change.before
          : lastToken(change.entityId);
      return status
        ? `Response status ${quote(status)} is no longer declared.`
        : undefined;
    }
    case 'RESPONSE_SET_SEMANTICS_AMBIGUOUS': {
      const before = stringList(change.before),
        after = stringList(change.after);
      return before && after
        ? `Declared response statuses changed from ${listed(before) || 'none'} to ${listed(after) || 'none'}.`
        : undefined;
    }
    case 'CODE_GENERATION_METADATA_CHANGED':
      return 'before' in change && 'after' in change
        ? `The operationId changed from ${value(change.before)} to ${value(change.after)}.`
        : undefined;
    default:
      return undefined;
  }
}

function transitionDetail(change: ChangeDetailInput): string | undefined {
  if (typeof change.before !== 'string' || typeof change.after !== 'string')
    return undefined;
  return `Observation state changed from ${quote(word(change.before))} to ${quote(word(change.after))}.`;
}

export function describeChangeDetail(
  change: ChangeDetailInput,
): string | undefined {
  const detail = (() => {
    switch (change.code) {
      case 'MCP_TOOL_INPUT_SCHEMA_CHANGED':
      case 'MCP_TOOL_OUTPUT_SCHEMA_CHANGED':
      case 'OPENAPI_PARAMETER_SCHEMA_CHANGED':
      case 'OPENAPI_REQUEST_SCHEMA_CHANGED':
      case 'OPENAPI_RESPONSE_SCHEMA_CHANGED':
        return (
          schemaDetail(change) ??
          (change.reasonCode === 'SCHEMA_COMPATIBILITY_EVIDENCE_UNAVAILABLE' ||
          change.reasonCode === 'SCHEMA_DIRECTIONAL_CONTAINMENT_PROVEN'
            ? fingerprintDetail(change)
            : undefined) ??
          openApiDetail(change)
        );
      case 'CAPABILITY_METADATA_CHANGED':
        return metadataDetail(change);
      case 'OPENAPI_PARAMETER_ADDED':
      case 'OPENAPI_PARAMETER_REQUIREDNESS_CHANGED':
      case 'OPENAPI_PARAMETER_REMOVED':
      case 'OPENAPI_REQUEST_BODY_REQUIREDNESS_CHANGED':
      case 'OPENAPI_RESPONSE_SET_CHANGED':
      case 'OPENAPI_OPERATION_ID_CHANGED':
        return openApiDetail(change);
      case 'PROTOCOL_VERSION_CHANGED':
        return 'before' in change && 'after' in change
          ? `Version changed from ${value(change.before)} to ${value(change.after)}.`
          : undefined;
      case 'ACCESS_NOW_REQUIRES_AUTH':
      case 'ACCESS_NOW_FORBIDDEN':
      case 'ACCESS_NOW_REQUIRES_PAYMENT':
      case 'ACCESS_BECAME_PUBLICLY_OBSERVABLE':
      case 'ENDPOINT_OBSERVATION_STATE_CHANGED':
        return transitionDetail(change);
      case 'CONSISTENCY_FINDING_CHANGED':
        return 'before' in change && 'after' in change
          ? `Result changed from ${quote(word(typeof change.before === 'string' ? change.before : 'not evaluated'))} to ${quote(word(typeof change.after === 'string' ? change.after : 'not evaluated'))}.`
          : undefined;
      default:
        return undefined;
    }
  })();
  return detail === undefined ? undefined : sentence(detail);
}
