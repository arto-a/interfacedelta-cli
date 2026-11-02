/** Display wording only: codes and compatibility classifications stay unchanged. */
export function schemaTypeDirectionLabel(
  code: string,
  reasonCode?: string,
): string | undefined {
  if (reasonCode !== 'TYPE_SET_RELAXED' && reasonCode !== 'TYPE_SET_RESTRICTED')
    return undefined;
  const output =
    code === 'MCP_TOOL_OUTPUT_SCHEMA_CHANGED' ||
    code === 'OPENAPI_RESPONSE_SCHEMA_CHANGED';
  const wider = reasonCode === 'TYPE_SET_RELAXED';
  return output
    ? wider
      ? 'Possible output types widened; callers may receive a type they did not handle before.'
      : 'Possible output types narrowed.'
    : wider
      ? 'Accepted input types widened.'
      : 'Accepted input types narrowed; previously valid inputs may be rejected.';
}
