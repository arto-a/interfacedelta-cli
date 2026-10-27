export const PROJECTION_VERSION =
  'json-schema-compatibility-projection-v1' as const;
export const DIALECT = 'https://json-schema.org/draft/2020-12/schema' as const;
export const LIMITS = {
  schemaBytes: 131072,
  nodes: 2000,
  depth: 32,
  refDepth: 16,
  findings: 64,
  factBytes: 512,
  enumValues: 256,
} as const;
export type Direction = 'input' | 'output';
export type Status =
  'compatible' | 'breaking' | 'indeterminate' | 'informational';
export type Classification =
  'breaking' | 'non_breaking' | 'indeterminate' | 'informational';
export type ReasonCode =
  | 'REQUIRED_PROPERTY_ADDED'
  | 'REQUIRED_PROPERTY_REMOVED'
  | 'TYPE_SET_RESTRICTED'
  | 'TYPE_SET_RELAXED'
  | 'ENUM_NARROWED'
  | 'ENUM_WIDENED'
  | 'LOWER_BOUND_RAISED'
  | 'LOWER_BOUND_LOWERED'
  | 'UPPER_BOUND_LOWERED'
  | 'UPPER_BOUND_RAISED'
  | 'MIN_LENGTH_RAISED'
  | 'MIN_LENGTH_LOWERED'
  | 'MAX_LENGTH_LOWERED'
  | 'MAX_LENGTH_RAISED'
  | 'MIN_ITEMS_RAISED'
  | 'MIN_ITEMS_LOWERED'
  | 'MAX_ITEMS_LOWERED'
  | 'MAX_ITEMS_RAISED'
  | 'ADDITIONAL_PROPERTIES_RESTRICTED'
  | 'ADDITIONAL_PROPERTIES_RELAXED'
  | 'PROPERTY_SCHEMA_RESTRICTED'
  | 'PROPERTY_SCHEMA_RELAXED'
  | 'ARRAY_ITEMS_RESTRICTED'
  | 'ARRAY_ITEMS_RELAXED'
  | 'ANNOTATION_ONLY_CHANGE'
  | 'UNSUPPORTED_SCHEMA_DIALECT'
  | 'UNSUPPORTED_SCHEMA_KEYWORD'
  | 'REMOTE_REF_NOT_RESOLVED'
  | 'LOCAL_REF_INVALID'
  | 'LOCAL_REF_CYCLE'
  | 'SCHEMA_ANALYSIS_LIMIT_REACHED'
  | 'INVALID_SCHEMA_SHAPE';
export interface Finding {
  direction: Direction;
  path: string;
  reasonCode: ReasonCode;
  classification: Classification;
  before: unknown;
  after: unknown;
  explanation: string;
}
type JT =
  'null' | 'boolean' | 'object' | 'array' | 'number' | 'integer' | 'string';
const ALL: JT[] = [
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
];
type Bound = { value: number; exclusive: boolean };
export type Node =
  | true
  | false
  | {
      types: JT[];
      values?: unknown[];
      lower?: Bound;
      upper?: Bound;
      minLength?: number;
      maxLength?: number;
      properties?: Record<string, Node>;
      required?: string[];
      additionalProperties?: Node;
      items?: Node;
      minItems?: number;
      maxItems?: number;
    };
export interface Projection {
  projectionVersion: typeof PROJECTION_VERSION;
  dialect: string;
  schema: Node;
  limitations: { reasonCode: ReasonCode; path: string; detail: string }[];
}
const annotations = new Set([
  'title',
  'description',
  'examples',
  'default',
  '$comment',
]);
const supported = new Set([
  '$schema',
  '$defs',
  '$ref',
  'type',
  'const',
  'enum',
  'minimum',
  'exclusiveMinimum',
  'maximum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  ...annotations,
]);
const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export const canonical = (v: unknown): string =>
  v === null || typeof v === 'boolean' || typeof v === 'string'
    ? JSON.stringify(v)
    : typeof v === 'number'
      ? JSON.stringify(Number.isFinite(v) ? v : null)
      : Array.isArray(v)
        ? `[${v.map(canonical).join(',')}]`
        : obj(v)
          ? `{${Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b, 'en'))
              .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
              .join(',')}}`
          : JSON.stringify(String(v));
const token = (v: string) => v.replace(/~1/g, '/').replace(/~0/g, '~');
const esc = (v: string) => v.replace(/~/g, '~0').replace(/\//g, '~1');
const fact = (v: unknown): unknown =>
  Buffer.byteLength(canonical(v)) <= LIMITS.factBytes
    ? v
    : `${canonical(v).slice(0, LIMITS.factBytes - 24)}…[bounded]`;
const annotationProjection = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(annotationProjection);
  if (!obj(v)) return undefined;
  return Object.fromEntries(
    Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .flatMap(([key, value]) => {
        if (annotations.has(key)) return [[key, value]];
        const nested = annotationProjection(value);
        return obj(nested) && Object.keys(nested).length ? [[key, nested]] : [];
      }),
  );
};

export function projectJsonSchema(input: unknown): Projection {
  const limitations: Projection['limitations'] = [];
  const add = (reasonCode: ReasonCode, path: string, detail: string) => {
    if (
      !limitations.some(
        (x) =>
          x.reasonCode === reasonCode && x.path === path && x.detail === detail,
      )
    )
      limitations.push({ reasonCode, path, detail });
  };
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(canonical(input));
  } catch {
    add('INVALID_SCHEMA_SHAPE', '$', 'not JSON-compatible');
  }
  if (bytes > LIMITS.schemaBytes)
    add('SCHEMA_ANALYSIS_LIMIT_REACHED', '$', 'schema byte limit reached');
  const root = input,
    dialect =
      obj(input) && typeof input.$schema === 'string' ? input.$schema : DIALECT;
  if (dialect !== DIALECT && dialect !== `${DIALECT}#`)
    add('UNSUPPORTED_SCHEMA_DIALECT', '$', dialect);
  let nodes = 0;
  const walk = (
    v: unknown,
    path: string,
    depth: number,
    refs: string[],
  ): Node => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) {
      add('SCHEMA_ANALYSIS_LIMIT_REACHED', path, 'node or depth limit reached');
      return true;
    }
    if (typeof v === 'boolean') return v;
    if (!obj(v)) {
      add('INVALID_SCHEMA_SHAPE', path, 'schema must be object or boolean');
      return true;
    }
    for (const key of Object.keys(v).sort())
      if (!supported.has(key))
        add('UNSUPPORTED_SCHEMA_KEYWORD', `${path}/${key}`, key);
    if (typeof v.$ref === 'string') {
      const refSibling = Object.keys(v)
        .sort()
        .find(
          (key) =>
            key !== '$ref' &&
            key !== '$schema' &&
            key !== '$defs' &&
            !annotations.has(key),
        );
      if (refSibling) {
        add(
          'UNSUPPORTED_SCHEMA_KEYWORD',
          `${path}/${refSibling}`,
          `$ref sibling ${refSibling}`,
        );
        return true;
      }
      const ref = v.$ref;
      if (!ref.startsWith('#')) {
        add('REMOTE_REF_NOT_RESOLVED', `${path}/$ref`, ref);
        return true;
      }
      if (refs.length >= LIMITS.refDepth) {
        add(
          'SCHEMA_ANALYSIS_LIMIT_REACHED',
          `${path}/$ref`,
          'ref depth limit reached',
        );
        return true;
      }
      if (refs.includes(ref)) {
        add('LOCAL_REF_CYCLE', `${path}/$ref`, ref);
        return true;
      }
      if (ref !== '#' && !ref.startsWith('#/')) {
        add('LOCAL_REF_INVALID', `${path}/$ref`, ref);
        return true;
      }
      let target = root;
      try {
        if (ref !== '#')
          for (const part of ref.slice(2).split('/')) {
            if (!obj(target) && !Array.isArray(target)) throw 0;
            target = (target as Record<string, unknown>)[token(part)];
            if (target === undefined) throw 0;
          }
      } catch {
        add('LOCAL_REF_INVALID', `${path}/$ref`, ref);
        return true;
      }
      return walk(target, path, depth + 1, [...refs, ref]);
    }
    let types: JT[] = [...ALL];
    if (typeof v.type === 'string') types = [v.type as JT];
    else if (Array.isArray(v.type)) types = [...new Set(v.type)].sort() as JT[];
    if (types.some((t) => !ALL.includes(t))) {
      add('INVALID_SCHEMA_SHAPE', `${path}/type`, 'unknown type');
      types = [...ALL];
    }
    let values: unknown[] | undefined;
    if (Object.hasOwn(v, 'const')) values = [v.const];
    else if (Array.isArray(v.enum)) {
      if (v.enum.length > LIMITS.enumValues)
        add(
          'SCHEMA_ANALYSIS_LIMIT_REACHED',
          `${path}/enum`,
          'enum limit reached',
        );
      else
        values = [
          ...new Map(v.enum.map((x) => [canonical(x), x])).values(),
        ].sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
    } else if (v.enum !== undefined)
      add('INVALID_SCHEMA_SHAPE', `${path}/enum`, 'enum must be array');
    const num = (key: string, natural = false) => {
      const x = v[key];
      if (x === undefined) return undefined;
      if (
        typeof x !== 'number' ||
        !Number.isFinite(x) ||
        (natural && (!Number.isInteger(x) || x < 0))
      ) {
        add('INVALID_SCHEMA_SHAPE', `${path}/${key}`, 'invalid numeric value');
        return undefined;
      }
      return x;
    };
    const min = num('minimum'),
      xmin = num('exclusiveMinimum'),
      max = num('maximum'),
      xmax = num('exclusiveMaximum');
    const lower =
      xmin !== undefined
        ? { value: xmin, exclusive: true }
        : min !== undefined
          ? { value: min, exclusive: false }
          : undefined;
    const upper =
      xmax !== undefined
        ? { value: xmax, exclusive: true }
        : max !== undefined
          ? { value: max, exclusive: false }
          : undefined;
    if (
      lower &&
      upper &&
      (lower.value > upper.value ||
        (lower.value === upper.value && (lower.exclusive || upper.exclusive)))
    )
      add('INVALID_SCHEMA_SHAPE', path, 'numeric interval is empty');
    const properties: Record<string, Node> = {};
    if (v.properties !== undefined) {
      if (!obj(v.properties))
        add(
          'INVALID_SCHEMA_SHAPE',
          `${path}/properties`,
          'properties must be object',
        );
      else
        for (const key of Object.keys(v.properties).sort())
          properties[key] = walk(
            v.properties[key],
            `${path}/properties/${esc(key)}`,
            depth + 1,
            refs,
          );
    }
    let required: string[] | undefined;
    if (v.required !== undefined) {
      if (
        !Array.isArray(v.required) ||
        v.required.some((x) => typeof x !== 'string')
      )
        add(
          'INVALID_SCHEMA_SHAPE',
          `${path}/required`,
          'required must be strings',
        );
      else required = [...new Set(v.required as string[])].sort();
    }
    const minLength = num('minLength', true),
      maxLength = num('maxLength', true),
      minItems = num('minItems', true),
      maxItems = num('maxItems', true);
    if (
      minLength !== undefined &&
      maxLength !== undefined &&
      minLength > maxLength
    )
      add('INVALID_SCHEMA_SHAPE', path, 'string length interval is empty');
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems)
      add('INVALID_SCHEMA_SHAPE', path, 'array length interval is empty');
    if (required && v.additionalProperties === false)
      for (const key of required)
        if (!Object.hasOwn(properties, key))
          add(
            'INVALID_SCHEMA_SHAPE',
            `${path}/required`,
            `required property ${key} is forbidden by additionalProperties`,
          );
    return {
      types: [...new Set(types)].sort(),
      values,
      lower,
      upper,
      minLength,
      maxLength,
      properties: Object.keys(properties).length ? properties : undefined,
      required,
      additionalProperties:
        v.additionalProperties === undefined
          ? undefined
          : walk(
              v.additionalProperties,
              `${path}/additionalProperties`,
              depth + 1,
              refs,
            ),
      items:
        v.items === undefined
          ? undefined
          : walk(v.items, `${path}/items`, depth + 1, refs),
      minItems,
      maxItems,
    };
  };
  const schema = walk(input, '$', 0, []);
  limitations.sort(
    (a, b) =>
      a.path.localeCompare(b.path, 'en') ||
      a.reasonCode.localeCompare(b.reasonCode, 'en') ||
      a.detail.localeCompare(b.detail, 'en'),
  );
  return {
    projectionVersion: PROJECTION_VERSION,
    dialect,
    schema,
    limitations,
  };
}
const ts = (n: Node) =>
  new Set<JT>(n === true ? ALL : n === false ? [] : n.types);
const typeSubset = (a: Set<JT>, b: Set<JT>) =>
  [...a].every((t) => b.has(t) || (t === 'integer' && b.has('number')));
const lowerOk = (s: Bound | undefined, t: Bound | undefined) =>
  !t ||
  (!!s &&
    (s.value > t.value ||
      (s.value === t.value && (!t.exclusive || s.exclusive))));
const upperOk = (s: Bound | undefined, t: Bound | undefined) =>
  !t ||
  (!!s &&
    (s.value < t.value ||
      (s.value === t.value && (!t.exclusive || s.exclusive))));
const jt = (v: unknown): JT =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'array'
      : typeof v === 'number'
        ? Number.isInteger(v)
          ? 'integer'
          : 'number'
        : (typeof v as JT);
const accepts = (n: Node, v: unknown) => {
  if (n === true) return true;
  if (n === false) return false;
  if (!typeSubset(new Set([jt(v)]), new Set(n.types))) return false;
  if (n.values && !n.values.some((x) => canonical(x) === canonical(v)))
    return false;
  if (
    typeof v === 'number' &&
    ((n.lower &&
      (v < n.lower.value || (v === n.lower.value && n.lower.exclusive))) ||
      (n.upper &&
        (v > n.upper.value || (v === n.upper.value && n.upper.exclusive))))
  )
    return false;
  if (
    typeof v === 'string' &&
    ((n.minLength !== undefined && [...v].length < n.minLength) ||
      (n.maxLength !== undefined && [...v].length > n.maxLength))
  )
    return false;
  return true;
};
const effective = (n: Exclude<Node, boolean>, key: string) =>
  n.properties?.[key] ?? n.additionalProperties ?? true;
function subset(source: Node, target: Node): boolean {
  if (source === false || target === true) return true;
  if (source === true) return false;
  if (target === false) return false;
  if (source.values) return source.values.every((v) => accepts(target, v));
  if (target.values) return false;
  const st = ts(source),
    tt = ts(target);
  if (!typeSubset(st, tt)) return false;
  if (
    [...st].some((t) => t === 'number' || t === 'integer') &&
    (!lowerOk(source.lower, target.lower) ||
      !upperOk(source.upper, target.upper))
  )
    return false;
  if (
    st.has('string') &&
    ((target.minLength ?? 0) > (source.minLength ?? 0) ||
      (target.maxLength ?? Infinity) < (source.maxLength ?? Infinity))
  )
    return false;
  if (
    st.has('array') &&
    ((target.minItems ?? 0) > (source.minItems ?? 0) ||
      (target.maxItems ?? Infinity) < (source.maxItems ?? Infinity) ||
      !subset(source.items ?? true, target.items ?? true))
  )
    return false;
  if (st.has('object')) {
    const sr = new Set(source.required ?? []),
      tr = new Set(target.required ?? []);
    if ([...tr].some((k) => !sr.has(k))) return false;
    for (const key of [
      ...new Set([
        ...Object.keys(source.properties ?? {}),
        ...Object.keys(target.properties ?? {}),
      ]),
    ])
      if (!subset(effective(source, key), effective(target, key))) return false;
    if (
      !subset(
        source.additionalProperties ?? true,
        target.additionalProperties ?? true,
      )
    )
      return false;
  }
  return true;
}
const classification = (s: Status): Classification =>
  s === 'compatible' ? 'non_breaking' : s;
function makeFindings(
  previous: Node,
  current: Node,
  direction: Direction,
  status: Status,
  path = '$',
): Finding[] {
  const out: Finding[] = [];
  if (typeof previous === 'boolean' || typeof current === 'boolean') {
    const compatible =
      direction === 'input'
        ? subset(previous, current)
        : subset(current, previous);
    return [
      {
        direction,
        path,
        reasonCode: compatible
          ? 'PROPERTY_SCHEMA_RELAXED'
          : 'PROPERTY_SCHEMA_RESTRICTED',
        classification: compatible ? 'non_breaking' : 'breaking',
        before: fact(previous),
        after: fact(current),
        explanation: 'The permitted values for this schema location changed.',
      },
    ];
  }
  const push = (
    reasonCode: ReasonCode,
    p: string,
    before: unknown,
    after: unknown,
    explanation: string,
    findingClassification = classification(status),
  ) =>
    out.push({
      direction,
      path: p,
      reasonCode,
      classification: findingClassification,
      before: fact(before),
      after: fact(after),
      explanation,
    });
  const pt = ts(previous),
    ct = ts(current);
  if (canonical([...pt]) !== canonical([...ct]))
    push(
      typeSubset(pt, ct) ? 'TYPE_SET_RELAXED' : 'TYPE_SET_RESTRICTED',
      `${path}/type`,
      previous.types,
      current.types,
      'The permitted JSON types changed.',
    );
  if (canonical(previous.values) !== canonical(current.values))
    push(
      (previous.values?.length ?? Infinity) >
        (current.values?.length ?? Infinity)
        ? 'ENUM_NARROWED'
        : 'ENUM_WIDENED',
      `${path}/enum`,
      previous.values ?? null,
      current.values ?? null,
      'The finite set of permitted values changed.',
    );
  const scalar = (
    a: number | undefined,
    b: number | undefined,
    up: ReasonCode,
    down: ReasonCode,
    p: string,
  ) => {
    if (a !== b)
      push(
        (b ?? -Infinity) > (a ?? -Infinity) ? up : down,
        p,
        a ?? null,
        b ?? null,
        'The validation boundary changed.',
      );
  };
  scalar(
    previous.lower?.value,
    current.lower?.value,
    'LOWER_BOUND_RAISED',
    'LOWER_BOUND_LOWERED',
    `${path}/minimum`,
  );
  scalar(
    previous.upper?.value,
    current.upper?.value,
    'UPPER_BOUND_RAISED',
    'UPPER_BOUND_LOWERED',
    `${path}/maximum`,
  );
  scalar(
    previous.minLength,
    current.minLength,
    'MIN_LENGTH_RAISED',
    'MIN_LENGTH_LOWERED',
    `${path}/minLength`,
  );
  scalar(
    previous.maxLength,
    current.maxLength,
    'MAX_LENGTH_RAISED',
    'MAX_LENGTH_LOWERED',
    `${path}/maxLength`,
  );
  scalar(
    previous.minItems,
    current.minItems,
    'MIN_ITEMS_RAISED',
    'MIN_ITEMS_LOWERED',
    `${path}/minItems`,
  );
  scalar(
    previous.maxItems,
    current.maxItems,
    'MAX_ITEMS_RAISED',
    'MAX_ITEMS_LOWERED',
    `${path}/maxItems`,
  );
  const pr = new Set(previous.required ?? []),
    cr = new Set(current.required ?? []);
  for (const key of [...new Set([...pr, ...cr])].sort())
    if (pr.has(key) !== cr.has(key))
      push(
        cr.has(key) ? 'REQUIRED_PROPERTY_ADDED' : 'REQUIRED_PROPERTY_REMOVED',
        `${path}/properties/${esc(key)}`,
        pr.has(key) ? 'required' : 'optional',
        cr.has(key) ? 'required' : 'optional',
        cr.has(key)
          ? 'A value previously allowed to omit this property may now be rejected.'
          : 'The property is no longer required.',
        (direction === 'input' ? cr.has(key) : !cr.has(key))
          ? 'breaking'
          : 'non_breaking',
      );
  if (
    canonical(previous.additionalProperties ?? true) !==
    canonical(current.additionalProperties ?? true)
  )
    push(
      current.additionalProperties === false
        ? 'ADDITIONAL_PROPERTIES_RESTRICTED'
        : 'ADDITIONAL_PROPERTIES_RELAXED',
      `${path}/additionalProperties`,
      previous.additionalProperties ?? true,
      current.additionalProperties ?? true,
      'The undeclared-property policy changed.',
    );
  for (const key of [
    ...new Set([
      ...Object.keys(previous.properties ?? {}),
      ...Object.keys(current.properties ?? {}),
    ]),
  ].sort())
    if (
      canonical(effective(previous, key)) !== canonical(effective(current, key))
    )
      out.push(
        ...makeFindings(
          effective(previous, key),
          effective(current, key),
          direction,
          (
            direction === 'input'
              ? subset(effective(previous, key), effective(current, key))
              : subset(effective(current, key), effective(previous, key))
          )
            ? 'compatible'
            : 'breaking',
          `${path}/properties/${esc(key)}`,
        ),
      );
  if (canonical(previous.items ?? true) !== canonical(current.items ?? true))
    out.push(
      ...makeFindings(
        previous.items ?? true,
        current.items ?? true,
        direction,
        (
          direction === 'input'
            ? subset(previous.items ?? true, current.items ?? true)
            : subset(current.items ?? true, previous.items ?? true)
        )
          ? 'compatible'
          : 'breaking',
        `${path}/items`,
      ),
    );
  return out;
}
export function analyzeSchemaCompatibility({
  previousSchema,
  currentSchema,
  direction,
}: {
  previousSchema: unknown;
  currentSchema: unknown;
  direction: Direction;
}) {
  const stored = (value: unknown): value is Projection =>
    obj(value) &&
    value.projectionVersion === PROJECTION_VERSION &&
    'schema' in value &&
    Array.isArray(value.limitations);
  const previousProjection = stored(previousSchema)
      ? previousSchema
      : projectJsonSchema(previousSchema),
    currentProjection = stored(currentSchema)
      ? currentSchema
      : projectJsonSchema(currentSchema),
    requiredContainment =
      direction === 'input'
        ? ('previous_subset_current' as const)
        : ('current_subset_previous' as const);
  const limits = [
    ...new Map(
      [...previousProjection.limitations, ...currentProjection.limitations].map(
        (value) => [
          value.reasonCode + '\u0000' + value.path + '\u0000' + value.detail,
          value,
        ],
      ),
    ).values(),
  ].sort(
    (a, b) =>
      a.path.localeCompare(b.path, 'en') ||
      a.reasonCode.localeCompare(b.reasonCode, 'en') ||
      a.detail.localeCompare(b.detail, 'en'),
  );
  if (limits.length)
    return {
      status: 'indeterminate' as const,
      requiredContainment,
      findings: limits.slice(0, LIMITS.findings).map((x) => ({
        direction,
        path: x.path,
        reasonCode: x.reasonCode,
        classification: 'indeterminate' as const,
        before: null,
        after: fact(x.detail),
        explanation:
          'Compatibility could not be proven within the supported deterministic fragment.',
      })),
      previousProjection,
      currentProjection,
    };
  const same =
    canonical(previousProjection.schema) ===
    canonical(currentProjection.schema);
  if (same) {
    const annotationsChanged =
      canonical(annotationProjection(previousSchema)) !==
      canonical(annotationProjection(currentSchema));
    return {
      status: annotationsChanged
        ? ('informational' as const)
        : ('compatible' as const),
      requiredContainment,
      findings: annotationsChanged
        ? [
            {
              direction,
              path: '$',
              reasonCode: 'ANNOTATION_ONLY_CHANGE' as const,
              classification: 'informational' as const,
              before: 'validation semantics unchanged',
              after: 'annotations changed',
              explanation: 'Only non-validation annotations changed.',
            },
          ]
        : [],
      previousProjection,
      currentProjection,
    };
  }
  const source =
      direction === 'input'
        ? previousProjection.schema
        : currentProjection.schema,
    target =
      direction === 'input'
        ? currentProjection.schema
        : previousProjection.schema,
    status = subset(source, target)
      ? ('compatible' as const)
      : ('breaking' as const);
  let findings = makeFindings(
    previousProjection.schema,
    currentProjection.schema,
    direction,
    status,
  );
  if (!findings.length)
    findings = [
      {
        direction,
        path: '$',
        reasonCode:
          status === 'breaking'
            ? 'PROPERTY_SCHEMA_RESTRICTED'
            : 'PROPERTY_SCHEMA_RELAXED',
        classification: classification(status),
        before: fact(previousProjection.schema),
        after: fact(currentProjection.schema),
        explanation:
          status === 'breaking'
            ? 'Required directional containment does not hold.'
            : 'Required directional containment holds within the supported fragment.',
      },
    ];
  if (findings.length > LIMITS.findings)
    return {
      status: 'indeterminate' as const,
      requiredContainment,
      findings: [
        {
          direction,
          path: '$',
          reasonCode: 'SCHEMA_ANALYSIS_LIMIT_REACHED' as const,
          classification: 'indeterminate' as const,
          before: null,
          after: `more than ${LIMITS.findings} findings`,
          explanation: 'The finding limit was reached.',
        },
      ],
      previousProjection,
      currentProjection,
    };
  findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path, 'en') ||
      a.reasonCode.localeCompare(b.reasonCode, 'en') ||
      canonical(a.before).localeCompare(canonical(b.before), 'en'),
  );
  return {
    status,
    requiredContainment,
    findings,
    previousProjection,
    currentProjection,
  };
}
