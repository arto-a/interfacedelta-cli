/** Publisher declarations are untrusted evidence, never observed execution. */
export const MCP_ANNOTATION_FIELDS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
  'title',
] as const;
export function mcpAnnotationValues(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    MCP_ANNOTATION_FIELDS.flatMap<[string, string | boolean]>((key) => {
      const v = source[key];
      return key === 'title'
        ? typeof v === 'string'
          ? [[key, v.slice(0, 300)]]
          : []
        : typeof v === 'boolean'
          ? [[key, v]]
          : [];
    }),
  );
}

/** Retain explicit extension fields only; no guessed semantics or fetching.
 * Paths identify the original field, including namespace prefixes. The pinned
 * A2A v1 schema has no native side-effect field; its extension params can.
 */
export function declaredSideEffects(
  value: unknown,
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  let visited = 0;
  let retainedBytes = 0;
  const limitations = new Set<string>();
  function walk(node: unknown, path: string[], depth: number) {
    if (!node || typeof node !== 'object') return;
    if (depth > 6 || ++visited > 256) {
      limitations.add('scan_bound');
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (++visited > 256) {
        limitations.add('scan_bound');
        break;
      }
      const field = key.split(/[:/#]/).at(-1) ?? key;
      if (
        /^(side_?effects?|readOnlyHint|destructiveHint|idempotentHint|openWorldHint)$/i.test(
          field,
        )
      ) {
        const json = JSON.stringify(child);
        const pointer =
          '/' +
          [...path, key]
            .map((p) => p.replaceAll('~', '~0').replaceAll('/', '~1'))
            .join('/');
        const bytes =
          Buffer.byteLength(json ?? '') + Buffer.byteLength(pointer);
        if (
          json === undefined ||
          Buffer.byteLength(json) > 4096 ||
          pointer.length > 2048 ||
          retainedBytes + bytes > 32768
        ) {
          limitations.add('retention_bound');
        } else {
          result[pointer] = child;
          retainedBytes += bytes;
        }
      } else walk(child, [...path, key], depth + 1);
    }
  }
  walk(value, [], 0);
  if (limitations.size) result.retentionLimitations = [...limitations].sort();
  return Object.keys(result).length ? result : undefined;
}
