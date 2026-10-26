import { describe, expect, it } from 'vitest';
import { analyzeSchemaCompatibility } from '@interfacedelta/schema-compatibility';
import { describeChangeDetail } from './change-detail';

const findings = (
  previousSchema: unknown,
  currentSchema: unknown,
  direction: 'input' | 'output' = 'input',
) =>
  analyzeSchemaCompatibility({ previousSchema, currentSchema, direction })
    .findings;

function detailsFor(
  previousSchema: unknown,
  currentSchema: unknown,
  direction: 'input' | 'output' = 'input',
) {
  return findings(previousSchema, currentSchema, direction).map((finding) =>
    describeChangeDetail({
      code:
        direction === 'input'
          ? 'MCP_TOOL_INPUT_SCHEMA_CHANGED'
          : 'MCP_TOOL_OUTPUT_SCHEMA_CHANGED',
      reasonCode: finding.reasonCode,
      path: finding.path,
      entityId: 'create_order',
      before: finding.before,
      after: finding.after,
    }),
  );
}

const object = (
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({ type: 'object', properties, ...extra });

describe('deterministic change detail', () => {
  it('names a property that became required', () => {
    expect(
      detailsFor(
        object({ currency: { type: 'string' } }),
        object({ currency: { type: 'string' } }, { required: ['currency'] }),
      ),
    ).toEqual(['“currency” is now required; before, it could be omitted.']);
  });

  it('removes bidi controls from quoted remote names', () => {
    const [detail] = detailsFor(
      object({ 'x\u202etnuocca': { type: 'string' } }),
      object(
        { 'x\u202etnuocca': { type: 'string' } },
        { required: ['x\u202etnuocca'] },
      ),
    );
    expect(detail).toBe(
      '“xtnuocca” is now required; before, it could be omitted.',
    );
  });

  it('names a property that is no longer required', () => {
    expect(
      detailsFor(
        object({ id: { type: 'string' } }, { required: ['id'] }),
        object({ id: { type: 'string' } }),
      ),
    ).toEqual(['“id” is no longer required and may now be omitted.']);
  });

  it('states a nested type change with both type sets', () => {
    expect(
      detailsFor(
        object({ order: object({ amount: { type: 'number' } }) }),
        object({ order: object({ amount: { type: 'integer' } }) }),
      ),
    ).toEqual([
      'Permitted types for “order.amount” changed from number to integer.',
    ]);
  });

  it('lists removed and added enum values', () => {
    expect(
      detailsFor(
        object({ status: { enum: ['draft', 'open'] } }),
        object({ status: { enum: ['archived', 'open'] } }),
      ),
    ).toEqual([
      'Allowed values for “status” changed: removed "draft"; added "archived".',
    ]);
  });

  it('states when a value becomes limited to a fixed set', () => {
    expect(
      detailsFor(
        object({ status: { type: 'string' } }),
        object({ status: { type: 'string', enum: ['open'] } }),
      ),
    ).toContain('Values for “status” are now limited to 1 allowed value.');
  });

  it('states numeric and length bounds with values', () => {
    expect(
      detailsFor(
        object({ amount: { type: 'number', minimum: 0 } }),
        object({ amount: { type: 'number', minimum: 10 } }),
      ),
    ).toEqual(['The lower bound for “amount” changed from 0 to 10.']);
    expect(
      detailsFor(
        object({ code: { type: 'string' } }),
        object({ code: { type: 'string', maxLength: 8 } }),
      ),
    ).toEqual(['The maximum length for “code” changed from none to 8.']);
  });

  it('describes array item changes with an items marker', () => {
    expect(
      detailsFor(
        object({ tags: { type: 'array', items: { type: 'string' } } }),
        object({ tags: { type: 'array', items: { type: 'integer' } } }),
      ),
    ).toEqual(['Permitted types for “tags[]” changed from string to integer.']);
  });

  it('describes a newly declared property and closed objects', () => {
    expect(
      detailsFor(object({}), object({ note: { type: 'string' } })),
    ).toEqual([
      '“note” now has its own schema; before, any value was accepted there.',
    ]);
    expect(
      detailsFor(object({}), object({}, { additionalProperties: false })),
    ).toEqual(['The top-level value no longer accepts undeclared properties.']);
  });

  it('names an unsupported keyword instead of only refusing', () => {
    expect(
      detailsFor(
        object({ a: { type: 'string' } }),
        object({ a: { type: 'string', pattern: '^x' } }),
      ),
    ).toEqual([
      '“a” uses the keyword “pattern”, which the deterministic analyzer does not model.',
    ]);
  });

  it('keeps hash-only evidence honest while showing short fingerprints', () => {
    const a = 'a'.repeat(64),
      b = 'b'.repeat(64);
    expect(
      describeChangeDetail({
        code: 'MCP_TOOL_INPUT_SCHEMA_CHANGED',
        reasonCode: 'SCHEMA_COMPATIBILITY_EVIDENCE_UNAVAILABLE',
        path: 'capabilities.inputSchemaSha256',
        entityId: 'create_order',
        before: a,
        after: b,
      }),
    ).toBe(
      'The schema fingerprint changed from aaaaaaaaaaaa… to bbbbbbbbbbbb…. A bounded schema projection was not retained for both observations, so the specific fields cannot be named.',
    );
    expect(
      describeChangeDetail({
        code: 'MCP_TOOL_OUTPUT_SCHEMA_CHANGED',
        reasonCode: 'SCHEMA_COMPATIBILITY_EVIDENCE_UNAVAILABLE',
        path: 'capabilities.outputSchemaSha256',
        entityId: 'create_order',
        before: null,
        after: b,
      }),
    ).toBe('A schema is now declared where none was recorded before.');
  });

  it('lists which display fields changed for metadata-only changes', () => {
    expect(
      describeChangeDetail({
        code: 'CAPABILITY_METADATA_CHANGED',
        reasonCode: 'DISPLAY_OR_NON_CONTRACT_METADATA_CHANGED',
        path: 'capabilities.metadata',
        entityId: 'capability:x',
        before: {
          name: 'create_order',
          title: 'Create order',
          description: 'old',
          metadata: { annotationsPresent: false, inputSchemaPresent: true },
        },
        after: {
          name: 'create_order',
          title: 'Place order',
          description: 'new',
          metadata: { annotationsPresent: true, inputSchemaPresent: true },
        },
      }),
    ).toBe(
      'Title changed from “Create order” to “Place order”; description changed; metadata field “annotationsPresent” changed.',
    );
  });

  it('names OpenAPI parameters, media types and response statuses', () => {
    expect(
      describeChangeDetail({
        code: 'OPENAPI_PARAMETER_ADDED',
        reasonCode: 'NEW_REQUIRED_INPUT_PARAMETER',
        path: 'parameters',
        entityId: 'GET /invoices query:currency',
        before: null,
        after: { key: 'query:currency', required: true },
      }),
    ).toBe('Query parameter “currency” was added as required.');
    expect(
      describeChangeDetail({
        code: 'OPENAPI_PARAMETER_REQUIREDNESS_CHANGED',
        reasonCode: 'OPTIONAL_PARAMETER_BECAME_REQUIRED',
        path: 'required',
        entityId: 'GET /invoices header:x-tenant',
      }),
    ).toBe('Header parameter “x-tenant” changed from optional to required.');
    expect(
      describeChangeDetail({
        code: 'OPENAPI_REQUEST_SCHEMA_CHANGED',
        reasonCode: 'REQUEST_MEDIA_TYPE_REMOVED',
        path: 'content',
        entityId: 'POST /invoices application/xml',
        before: 'c'.repeat(64),
        after: null,
      }),
    ).toBe('Request media type “application/xml” is no longer declared.');
    expect(
      describeChangeDetail({
        code: 'OPENAPI_RESPONSE_SET_CHANGED',
        reasonCode: 'RESPONSE_STATUS_REMOVAL_COMPATIBILITY_NOT_PROVEN',
        path: 'responses',
        entityId: 'GET /invoices 404',
        before: '404',
        after: null,
      }),
    ).toBe('Response status “404” is no longer declared.');
  });

  it('states observation-state transitions', () => {
    expect(
      describeChangeDetail({
        code: 'ACCESS_NOW_REQUIRES_PAYMENT',
        reasonCode: 'PUBLIC_OBSERVATION_NOW_PAYMENT_REQUIRED',
        path: 'endpoints.observationStatus',
        entityId: 'endpoint:x',
        before: 'valid',
        after: 'payment_required',
      }),
    ).toBe('Observation state changed from “valid” to “payment required”.');
  });

  it('works from code and path alone when values are not loaded', () => {
    expect(
      describeChangeDetail({
        code: 'MCP_TOOL_INPUT_SCHEMA_CHANGED',
        reasonCode: 'REQUIRED_PROPERTY_ADDED',
        path: '$/properties/currency',
        entityId: 'create_order',
      }),
    ).toBe('“currency” is now required; before, it could be omitted.');
    expect(
      describeChangeDetail({
        code: 'MCP_TOOL_INPUT_SCHEMA_CHANGED',
        reasonCode: 'LOWER_BOUND_RAISED',
        path: '$/properties/amount/minimum',
        entityId: 'create_order',
      }),
    ).toBe('The lower bound for “amount” was raised.');
    expect(
      describeChangeDetail({
        code: 'MCP_TOOL_INPUT_SCHEMA_CHANGED',
        reasonCode: 'MAX_LENGTH_RAISED',
        path: '$/properties/code/maxLength',
        entityId: 'create_order',
      }),
    ).toBe('The maximum length for “code” changed.');
  });

  it('returns nothing when the evidence does not support a precise statement', () => {
    for (const change of [
      {
        code: 'CAPABILITY_REMOVED',
        reasonCode: 'PREVIOUSLY_PRESENT_CURRENTLY_ABSENT_COMPLETE_INVENTORIES',
        path: 'capabilities',
        entityId: 'capability:x',
      },
      {
        code: 'MCP_TOOL_INPUT_SCHEMA_CHANGED',
        reasonCode: 'PROPERTY_SCHEMA_RESTRICTED',
        path: '$',
        entityId: 'create_order',
        before: { types: ['object'] },
        after: { types: ['object'], required: [] },
      },
      {
        code: 'MCP_TOOL_INPUT_SCHEMA_CHANGED',
        reasonCode: 'TYPE_SET_RESTRICTED',
        path: '$/unexpected/segment/type',
        entityId: 'create_order',
      },
      {
        code: 'UNKNOWN_FUTURE_CODE',
        reasonCode: 'X',
        path: '$',
        entityId: 'x',
      },
    ])
      expect(describeChangeDetail(change)).toBeUndefined();
  });

  it('bounds untrusted text', () => {
    const detail = describeChangeDetail({
      code: 'CAPABILITY_METADATA_CHANGED',
      reasonCode: 'DISPLAY_OR_NON_CONTRACT_METADATA_CHANGED',
      path: 'capabilities.metadata',
      entityId: 'x',
      before: { name: 'n', title: 'a'.repeat(500), metadata: {} },
      after: { name: 'n', title: 'b'.repeat(500), metadata: {} },
    })!;
    expect(detail.length).toBeLessThanOrEqual(240);
    expect(detail).toContain('…');
  });
});
