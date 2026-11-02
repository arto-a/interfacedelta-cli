/** Fixed-vocabulary observations only. Never return publisher text or offsets. */
export const DESCRIPTION_CHECKS_VERSION = 'description-checks-v1' as const;
export const DESCRIPTION_CHECK_CODES = [
  'INVISIBLE_CHARACTERS',
  'INSTRUCTION_TO_MODEL',
  'CREDENTIAL_OR_FILE_REQUEST',
  'CROSS_TOOL_REFERENCE',
  'HIDDEN_SCHEMA_TEXT',
  'DESCRIPTION_CHANGED_WITHOUT_REVISION',
] as const;
export type DescriptionCheckCode = (typeof DESCRIPTION_CHECK_CODES)[number];
export type DescriptionCheckFact = {
  code: DescriptionCheckCode;
  count: number;
  location: 'description' | 'input_schema' | 'name';
};
export const MODEL_INSTRUCTION_PATTERNS = [
  /\bignore\s+(?:all|any|previous)\s+instructions\b/gu,
  /\bdo\s+not\s+tell\s+the\s+user\b/gu,
  /\bbefore\s+using\s+any\s+other\s+tool\b/gu,
  /<important>/gu,
  /\bsystem\s+prompt\b/gu,
  /\byou\s+must\s+always\s+call\b/gu,
] as const;
export type DescriptionCheckInput = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  otherToolNames?: readonly string[];
  descriptionComparison?: {
    previousHash: string;
    currentHash: string;
    previousRevision?: string;
    currentRevision?: string;
  };
};
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
const occurrences = (text: string, pattern: RegExp) =>
  [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
export const DESCRIPTION_CHARACTER_LIMIT = 1_100_000;
export type DescriptionCheckContext = {
  names: ReadonlySet<string>;
  budget: { remaining: number };
};
export function descriptionCheckContext(
  names: readonly string[],
  budget = { remaining: DESCRIPTION_CHARACTER_LIMIT },
): DescriptionCheckContext {
  const indexed = new Set<string>();
  for (const name of names) {
    if (name.length > budget.remaining) break;
    budget.remaining -= name.length;
    indexed.add(normalize(name));
  }
  return { names: indexed, budget };
}

export function checkToolDescription(
  input: DescriptionCheckInput,
  context = descriptionCheckContext(input.otherToolNames ?? []),
): DescriptionCheckFact[] {
  const counts = new Map<string, DescriptionCheckFact>();
  const add = (
    code: DescriptionCheckCode,
    count: number,
    location: DescriptionCheckFact['location'],
  ) => {
    if (!count) return;
    const key = `${location}:${code}`;
    counts.set(key, {
      code,
      count: count + (counts.get(key)?.count ?? 0),
      location,
    });
  };
  const ownName = normalize(input.name.slice(0, context.budget.remaining));
  context.budget.remaining -= Math.min(
    input.name.length,
    context.budget.remaining,
  );
  function inspect(raw: string, location: DescriptionCheckFact['location']) {
    if (context.budget.remaining <= 0) return;
    raw = raw.slice(0, context.budget.remaining);
    context.budget.remaining -= raw.length;
    const text = normalize(raw);
    const invisible = occurrences(
      raw,
      /[\p{Cf}\u034f\u180e\u200b-\u200d\ufeff\u{e0000}-\u{e007f}]/gu,
    );
    const instructions = MODEL_INSTRUCTION_PATTERNS.reduce(
      (n, pattern) => n + occurrences(text, pattern),
      0,
    );
    // Require an action and a named target in the same bounded clause.
    const credentials = occurrences(
      text,
      /\b(?:read|send|upload|copy|open|access|retrieve|include|attach)\b[^.!?\n]{0,80}?(?:~\/\.ssh\b|\bid_rsa\b|(?<![\w])\.env\b|\bapi[ -]key\b|\bprivate[ -]key\b|\/etc\/passwd\b|\bmcp\.json\b)/gu,
    );
    let cross = 0;
    // Tokenise once; name lookup is constant time, independent of server tool count.
    for (const match of text.matchAll(
      /\b(?:before (?:using|calling)|instead of (?:using|calling)|never (?:use|call)|always (?:use|call)|do not (?:use|call))\s+[`'"]?([^\s`'"!,;:?]+)/gu,
    )) {
      const name = match[1]!.replace(/\.+$/, '');
      if (name !== ownName && context.names.has(name)) cross++;
    }
    add('INVISIBLE_CHARACTERS', invisible, location);
    add('INSTRUCTION_TO_MODEL', instructions, location);
    add('CREDENTIAL_OR_FILE_REQUEST', credentials, location);
    add('CROSS_TOOL_REFERENCE', cross, location);
    if (location === 'input_schema')
      add(
        'HIDDEN_SCHEMA_TEXT',
        invisible + instructions + credentials + cross,
        location,
      );
  }
  inspect(input.name, 'name');
  if (input.description !== undefined)
    inspect(input.description, 'description');
  // Iterative traversal avoids a stack limit. A seen set also accepts cyclic caller objects.
  function walk(root: unknown, schema: boolean) {
    const stack = [root];
    const seen = new Set<object>();
    while (stack.length && context.budget.remaining > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        if (
          typeof value === 'string' &&
          (!schema || key === 'description' || key === 'default')
        )
          inspect(value, schema ? 'input_schema' : 'description');
        else if (value && typeof value === 'object') stack.push(value);
      }
    }
  }
  walk(input.inputSchema, true);
  walk(input.annotations, false);
  const c = input.descriptionComparison;
  if (
    c &&
    c.previousHash &&
    c.currentHash &&
    c.previousHash !== c.currentHash &&
    c.previousRevision &&
    c.previousRevision === c.currentRevision
  )
    add('DESCRIPTION_CHANGED_WITHOUT_REVISION', 1, 'description');
  return [...counts.values()].sort((a, b) =>
    a.location < b.location
      ? -1
      : a.location > b.location
        ? 1
        : DESCRIPTION_CHECK_CODES.indexOf(a.code) -
          DESCRIPTION_CHECK_CODES.indexOf(b.code),
  );
}
