import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  analyzeSchemaCompatibility as analyze,
  LIMITS,
  projectJsonSchema,
} from './index';
const result = (
  previousSchema: unknown,
  currentSchema: unknown,
  direction: 'input' | 'output' = 'input',
) => analyze({ previousSchema, currentSchema, direction });
const object = (
  properties: Record<string, unknown> = {},
  required: string[] = [],
  additionalProperties: unknown = false,
) => ({ type: 'object', properties, required, additionalProperties });
describe('directional JSON Schema compatibility', () => {
  it.each([
    [
      'required added',
      object({ x: { type: 'string' } }),
      object({ x: { type: 'string' } }, ['x']),
      'breaking',
    ],
    [
      'required removed',
      object({ x: { type: 'string' } }, ['x']),
      object({ x: { type: 'string' } }),
      'compatible',
    ],
    ['number to integer', { type: 'number' }, { type: 'integer' }, 'breaking'],
    [
      'integer to number',
      { type: 'integer' },
      { type: 'number' },
      'compatible',
    ],
    ['enum narrowed', { enum: ['a', 'b'] }, { enum: ['a'] }, 'breaking'],
    ['enum widened', { enum: ['a'] }, { enum: ['a', 'b'] }, 'compatible'],
    [
      'minimum raised',
      { type: 'number', minimum: 0 },
      { type: 'number', minimum: 10 },
      'breaking',
    ],
    [
      'minimum lowered',
      { type: 'number', minimum: 10 },
      { type: 'number', minimum: 0 },
      'compatible',
    ],
    [
      'maximum lowered',
      { type: 'number', maximum: 100 },
      { type: 'number', maximum: 50 },
      'breaking',
    ],
    [
      'maximum raised',
      { type: 'number', maximum: 50 },
      { type: 'number', maximum: 100 },
      'compatible',
    ],
    [
      'minLength raised',
      { type: 'string', minLength: 1 },
      { type: 'string', minLength: 2 },
      'breaking',
    ],
    [
      'minLength lowered',
      { type: 'string', minLength: 2 },
      { type: 'string', minLength: 1 },
      'compatible',
    ],
    [
      'maxLength lowered',
      { type: 'string', maxLength: 4 },
      { type: 'string', maxLength: 3 },
      'breaking',
    ],
    [
      'maxLength raised',
      { type: 'string', maxLength: 3 },
      { type: 'string', maxLength: 4 },
      'compatible',
    ],
    [
      'additional properties restricted',
      object({}, [], true),
      object({}, [], false),
      'breaking',
    ],
    [
      'additional properties relaxed',
      object({}, [], false),
      object({}, [], true),
      'compatible',
    ],
  ] as const)('%s input', (_name, previous, current, status) =>
    expect(result(previous, current).status).toBe(status),
  );
  it.each([
    [
      'required removed',
      object({ x: { type: 'string' } }, ['x']),
      object({ x: { type: 'string' } }),
      'breaking',
    ],
    [
      'number to integer',
      { type: 'number' },
      { type: 'integer' },
      'compatible',
    ],
    ['integer to number', { type: 'integer' }, { type: 'number' }, 'breaking'],
    ['enum narrowed', { enum: ['a', 'b'] }, { enum: ['a'] }, 'compatible'],
    ['enum widened', { enum: ['a'] }, { enum: ['a', 'b'] }, 'breaking'],
    [
      'range narrowed',
      { type: 'number', minimum: 0, maximum: 100 },
      { type: 'number', minimum: 10, maximum: 50 },
      'compatible',
    ],
    [
      'range widened',
      { type: 'number', minimum: 10, maximum: 50 },
      { type: 'number', minimum: 0, maximum: 100 },
      'breaking',
    ],
    [
      'additional properties restricted',
      object({}, [], true),
      object({}, [], false),
      'compatible',
    ],
    [
      'additional properties relaxed',
      object({}, [], false),
      object({}, [], true),
      'breaking',
    ],
  ] as const)('%s output', (_name, previous, current, status) =>
    expect(result(previous, current, 'output').status).toBe(status),
  );
  it('handles inclusive and exclusive boundaries', () => {
    expect(
      result(
        { type: 'number', minimum: 0 },
        { type: 'number', exclusiveMinimum: 0 },
      ).status,
    ).toBe('breaking');
    expect(
      result(
        { type: 'number', exclusiveMinimum: 0 },
        { type: 'number', minimum: 0 },
      ).status,
    ).toBe('compatible');
    expect(
      result(
        { type: 'number', maximum: 1 },
        { type: 'number', exclusiveMaximum: 1 },
      ).status,
    ).toBe('breaking');
  });
  it('does not call an optional declared property compatible when the previous object was open', () => {
    expect(
      result(
        { type: 'object' },
        { type: 'object', properties: { x: { type: 'string' } } },
      ).status,
    ).toBe('breaking');
  });
  it('recurses through nested objects and homogeneous arrays', () => {
    const a = object(
      {
        nested: object(
          { values: { type: 'array', items: { type: 'number' }, maxItems: 5 } },
          ['values'],
        ),
      },
      ['nested'],
    );
    const b = object(
      {
        nested: object(
          {
            values: { type: 'array', items: { type: 'integer' }, maxItems: 4 },
          },
          ['values'],
        ),
      },
      ['nested'],
    );
    expect(result(a, b).status).toBe('breaking');
    expect(result(a, b, 'output').status).toBe('compatible');
  });
  it('supports boolean schemas, const, and type arrays', () => {
    expect(result(false, true).status).toBe('compatible');
    expect(result(true, false).status).toBe('breaking');
    expect(result({ const: 'a' }, { enum: ['a', 'b'] }).status).toBe(
      'compatible',
    );
    expect(
      result({ type: ['integer', 'string'] }, { type: ['number', 'string'] })
        .status,
    ).toBe('compatible');
  });
  it('classifies annotation-only changes as informational', () =>
    expect(
      result(
        { type: 'string', description: 'a' },
        { type: 'string', description: 'b' },
      ).status,
    ).toBe('informational'));
  it.each([
    [
      { type: 'string', pattern: 'a' },
      { type: 'string', pattern: 'b' },
      'UNSUPPORTED_SCHEMA_KEYWORD',
    ],
    [
      { $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' },
      { $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' },
      'UNSUPPORTED_SCHEMA_DIALECT',
    ],
    [
      { $ref: 'https://example.com/schema' },
      { $ref: 'https://example.com/schema' },
      'REMOTE_REF_NOT_RESOLVED',
    ],
  ] as const)(
    'returns indeterminate for unsupported semantics',
    (a, b, reason) => {
      const value = result(a, b);
      expect(value.status).toBe('indeterminate');
      expect(value.findings[0]?.reasonCode).toBe(reason);
    },
  );
  it('resolves escaped local JSON pointers', () => {
    const a = { $defs: { 'a/b': { type: 'integer' } }, $ref: '#/$defs/a~1b' };
    const b = { $defs: { 'a/b': { type: 'number' } }, $ref: '#/$defs/a~1b' };
    expect(result(a, b).status).toBe('compatible');
  });
  it('terminates cyclic local references', () => {
    const cyclic = {
      $defs: { node: { $ref: '#/$defs/node' } },
      $ref: '#/$defs/node',
    };
    expect(result(cyclic, cyclic).status).toBe('indeterminate');
    expect(result(cyclic, cyclic).findings[0]?.reasonCode).toBe(
      'LOCAL_REF_CYCLE',
    );
  });
  it('fails boundedly for oversized enums and deep schemas', () => {
    expect(
      result(
        { enum: Array.from({ length: LIMITS.enumValues + 1 }, (_, i) => i) },
        { enum: [1] },
      ).status,
    ).toBe('indeterminate');
    let deep: unknown = { type: 'string' };
    for (let i = 0; i < LIMITS.depth + 2; i++)
      deep = { type: 'array', items: deep };
    expect(result(deep, deep).status).toBe('indeterminate');
  });
  it('does not ignore validation siblings beside a local ref', () => {
    const schema = {
      $defs: { value: { type: 'string' } },
      $ref: '#/$defs/value',
      minLength: 2,
    };
    expect(result(schema, schema)).toMatchObject({
      status: 'indeterminate',
      findings: [{ reasonCode: 'UNSUPPORTED_SCHEMA_KEYWORD' }],
    });
  });
  it.each([
    [{ type: 'number', minimum: 2, maximum: 1 }],
    [{ type: 'string', minLength: 2, maxLength: 1 }],
    [{ type: 'array', minItems: 2, maxItems: 1 }],
    [
      {
        type: 'object',
        required: ['missing'],
        additionalProperties: false,
      },
    ],
  ])(
    'does not prove compatibility for an internally empty fragment',
    (schema) => {
      expect(result(schema, schema).status).toBe('indeterminate');
      expect(result(schema, schema).findings[0]?.reasonCode).toBe(
        'INVALID_SCHEMA_SHAPE',
      );
    },
  );
  it('is deterministic across property, defs, enum, and required order', () => {
    const a = {
      $defs: { z: { type: 'string' }, a: { type: 'integer' } },
      type: 'object',
      properties: { z: { $ref: '#/$defs/z' }, a: { $ref: '#/$defs/a' } },
      required: ['z', 'a'],
      additionalProperties: false,
    };
    const b = {
      additionalProperties: false,
      required: ['a', 'z'],
      properties: { a: { $ref: '#/$defs/a' }, z: { $ref: '#/$defs/z' } },
      type: 'object',
      $defs: { a: { type: 'integer' }, z: { type: 'string' } },
    };
    expect(result(a, b)).toEqual(result(b, a));
    expect(result({ enum: ['b', 'a'] }, { enum: ['a', 'b'] })).toMatchObject({
      status: 'compatible',
      findings: [],
    });
  });
});

describe('annotation evidence', () => {
  it.each([
    'title',
    'description',
    'default',
    'examples',
    '$comment',
    'deprecated',
    'readOnly',
    'writeOnly',
  ])('ignores %s validation semantics', (keyword) => {
    const a = {
      type: 'string',
      [keyword]:
        keyword === 'examples'
          ? ['a']
          : ['deprecated', 'readOnly', 'writeOnly'].includes(keyword)
            ? true
            : 'a',
    };
    const b = {
      type: 'string',
      [keyword]:
        keyword === 'examples'
          ? ['b']
          : ['deprecated', 'readOnly', 'writeOnly'].includes(keyword)
            ? false
            : 'b',
    };
    expect(result(a, b).status).toBe('informational');
    expect(result(projectJsonSchema(a), projectJsonSchema(b)).status).toBe(
      'compatible',
    );
  });
  it('retains a required-field change beside annotation limitations', () => {
    const a = object({ x: { type: 'string', deprecated: true } });
    const b = { ...a, required: ['x'] };
    expect(result(projectJsonSchema(a), projectJsonSchema(b)).status).toBe(
      'breaking',
    );
    expect(result(projectJsonSchema(b), projectJsonSchema(a)).status).toBe(
      'compatible',
    );
  });
  it('does not erase a lost ref target from old annotation-sibling evidence', () => {
    const a = {
      $defs: { value: { type: 'string' } },
      $ref: '#/$defs/value',
      deprecated: true,
    };
    expect(result(projectJsonSchema(a), projectJsonSchema(a)).status).toBe(
      'indeterminate',
    );
  });
});

const keywordFixtures = [
  {
    type: 'string',
    title: 'Title',
    description: 'Description',
    default: 'x',
    examples: ['x'],
  },
  { type: 'string', deprecated: true, readOnly: true, writeOnly: false },
  { $defs: { x: { type: 'string' } }, $ref: '#/$defs/x', deprecated: true },
  { type: 'string', format: 'email' },
  { type: 'string', nullable: true },
  { anyOf: [{ type: 'string' }, { type: 'null' }] },
  { oneOf: [{ type: 'string' }, { type: 'null' }] },
  { const: 'a' },
  { type: 'object', additionalProperties: { type: 'string' } },
];

describe('keyword boundaries', () => {
  it.each(['format', 'nullable', 'anyOf', 'oneOf', 'unknownValidationKeyword'])(
    'keeps %s indeterminate without supported semantics',
    (keyword) => {
      const value =
        keyword === 'format'
          ? 'email'
          : keyword === 'nullable'
            ? true
            : [{ type: 'string' }];
      const a = { type: 'string' };
      const b = { ...a, [keyword]: value };
      for (const [before, after] of [
        [a, b],
        [b, a],
      ]) {
        expect(result(before, after).status).toBe('indeterminate');
        expect(
          result(projectJsonSchema(before), projectJsonSchema(after)).status,
        ).toBe('indeterminate');
      }
    },
  );
  it.each([
    'title',
    'description',
    'default',
    'examples',
    '$comment',
    'deprecated',
    'readOnly',
    'writeOnly',
  ])('resolves raw $ref with %s annotation siblings', (keyword) => {
    const a = {
      $defs: { x: { type: 'integer' } },
      $ref: '#/$defs/x',
      [keyword]: true,
    };
    const b = { ...a, $defs: { x: { type: 'number' } } };
    expect(result(a, b).status).toBe('compatible');
    expect(result(b, a).status).toBe('breaking');
  });
  it('never treats assertion siblings of $ref as annotations', () => {
    const a = {
      $defs: { x: { type: 'string' } },
      $ref: '#/$defs/x',
      minLength: 3,
      deprecated: true,
    };
    expect(result(a, a).status).toBe('indeterminate');
  });
  it.each([
    [{ enum: ['a', 'b'] }, { const: 'a' }],
    [
      { type: 'object', additionalProperties: true },
      { type: 'object', additionalProperties: false },
    ],
    [
      { type: 'object', additionalProperties: { type: 'number' } },
      { type: 'object', additionalProperties: { type: 'integer' } },
    ],
  ])(
    'preserves narrowing and widening for supported keyword forms',
    (wide, narrow) => {
      expect(
        result(projectJsonSchema(wide), projectJsonSchema(narrow)).status,
      ).toBe('breaking');
      expect(
        result(projectJsonSchema(narrow), projectJsonSchema(wide)).status,
      ).toBe('compatible');
    },
  );
  it('keeps the persisted projections byte-identical to 3e404b50', () => {
    expect(
      createHash('sha256')
        .update(JSON.stringify(keywordFixtures.map(projectJsonSchema)))
        .digest('hex'),
    ).toBe('bb9afe7e14b9a429a31c9eacb2bae0831f35ace05e4f5b9a7ef353995d9e585f');
  });
});

describe('finite values retain structural constraints', () => {
  it.each([
    [{ const: {} }, { type: 'object', required: ['x'], deprecated: true }],
    [
      { const: { x: 1 } },
      { type: 'object', properties: { x: { type: 'string' } }, readOnly: true },
    ],
    [
      { enum: [{ x: 1 }] },
      { type: 'object', additionalProperties: false, deprecated: false },
    ],
    [
      { const: ['x'] },
      { type: 'array', items: { type: 'number' }, writeOnly: true },
    ],
    [{ const: [] }, { type: 'array', minItems: 1, deprecated: true }],
    [{ const: [1, 2] }, { type: 'array', maxItems: 1, deprecated: true }],
  ])(
    'does not prove containment for a value rejected by nested constraints',
    (before, after) => {
      expect(
        result(projectJsonSchema(before), projectJsonSchema(after)).status,
      ).toBe('breaking');
      expect(
        result(projectJsonSchema(after), projectJsonSchema(before), 'output')
          .status,
      ).toBe('breaking');
    },
  );
  it('accepts finite nested values when all structural constraints hold', () => {
    const value = { const: { x: [1] } };
    const schema = {
      type: 'object',
      required: ['x'],
      additionalProperties: false,
      properties: {
        x: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: { type: 'number' },
        },
      },
      deprecated: true,
    };
    expect(
      result(projectJsonSchema(value), projectJsonSchema(schema)).status,
    ).toBe('compatible');
  });
});
