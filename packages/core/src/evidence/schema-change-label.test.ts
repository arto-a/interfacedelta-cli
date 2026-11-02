import { expect, it } from 'vitest';
import { schemaTypeDirectionLabel } from './schema-change-label';
it('explains output widening from the consumer direction without renaming the code', () => {
  expect(
    schemaTypeDirectionLabel(
      'MCP_TOOL_OUTPUT_SCHEMA_CHANGED',
      'TYPE_SET_RELAXED',
    ),
  ).toContain('callers may receive a type');
  expect(
    schemaTypeDirectionLabel(
      'MCP_TOOL_INPUT_SCHEMA_CHANGED',
      'TYPE_SET_RELAXED',
    ),
  ).toBe('Accepted input types widened.');
  expect(
    schemaTypeDirectionLabel(
      'OPENAPI_RESPONSE_SCHEMA_CHANGED',
      'TYPE_SET_RESTRICTED',
    ),
  ).toBe('Possible output types narrowed.');
  expect(
    schemaTypeDirectionLabel('MCP_TOOL_INPUT_SCHEMA_CHANGED', 'OTHER'),
  ).toBeUndefined();
});
