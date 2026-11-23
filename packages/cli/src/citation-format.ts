/** Citation v1 deliberately has no Markdown or shell interpretation. */
export type CitationMetadata = { checked?: string; label?: string };
export type ToolCitation = CitationMetadata & {
  kind?: 'mcp-tool';
  endpoint: string;
  tool: string;
  fingerprint: string;
  answer?: string;
};
export type FileCitation = CitationMetadata & {
  kind: 'file';
  path: string;
  sha256: string;
};
export type UrlCitation = CitationMetadata & {
  kind: 'url';
  uri: string;
  sha256: string;
};
export type GitCitation = CitationMetadata & {
  kind: 'git';
  repo: string;
  commit: string;
  path?: string;
};
export type SourceCitation = FileCitation | UrlCitation | GitCitation;
export type Citation = ToolCitation | SourceCitation;
export const isToolCitation = (citation: Citation): citation is ToolCitation =>
  citation.kind === undefined || citation.kind === 'mcp-tool';
export type ParsedCitation = {
  line: number;
  start: number;
  end: number;
} & (
  { citation: Citation; error?: never } | { error: string; citation?: never }
);

export const CITATION_FINGERPRINT = /^sha256:[a-fA-F0-9]{64}$/;
/** Record Check currently returns bare hex; citations always spell out sha256. */
export function citationFingerprint(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^(?:sha256:)?[a-fA-F0-9]{64}$/.test(value)
    ? `sha256:${value.replace(/^sha256:/, '').toLowerCase()}`
    : undefined;
}
const hasControl = (value: string): boolean =>
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
export function citationEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      /^https:\/\//.test(value) &&
      !/[\s<>"'\\]/.test(value) &&
      !hasControl(value) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[?#]$/.test(value)
    );
  } catch {
    return false;
  }
}
export function citationPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\:]/.test(value) &&
    !hasControl(value) &&
    !value.startsWith('/') &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
/** Source URLs may contain public queries, but never URL credentials. */
export function citationUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      /^https:\/\//.test(value) &&
      !/[\s<>"'\\]/.test(value) &&
      !hasControl(value) &&
      !url.username &&
      !url.password &&
      !value.split('/')[2]!.includes('@')
    );
  } catch {
    return false;
  }
}
const sourcePath = (value: string): boolean =>
  citationPath(value) && !/[<>"']/.test(value);
const ATTRIBUTES = {
  'mcp-tool': [
    'kind',
    'endpoint',
    'tool',
    'fingerprint',
    'checked',
    'answer',
    'label',
  ],
  file: ['kind', 'path', 'sha256', 'checked', 'label'],
  url: ['kind', 'uri', 'sha256', 'checked', 'label'],
  git: ['kind', 'repo', 'commit', 'path', 'checked', 'label'],
};
export function validCitation(value: Citation): boolean {
  const kind = value.kind ?? 'mcp-tool';
  if (
    !Object.hasOwn(ATTRIBUTES, kind) ||
    Object.keys(value).some((key) => !ATTRIBUTES[kind].includes(key))
  )
    return false;
  if (
    value.checked !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value.checked) ||
      !Number.isFinite(Date.parse(value.checked)) ||
      new Date(value.checked).toISOString().slice(0, 10) !== value.checked)
  )
    return false;
  if (
    value.label !== undefined &&
    ([...value.label].length > 120 ||
      /--|>/.test(value.label) ||
      (value.label.includes('"') && value.label.includes("'")) ||
      hasControl(value.label))
  )
    return false;
  if (isToolCitation(value))
    return (
      typeof value.endpoint === 'string' &&
      citationEndpoint(value.endpoint) &&
      typeof value.tool === 'string' &&
      value.tool.length > 0 &&
      value.tool.length <= 128 &&
      !/[<>"']/.test(value.tool) &&
      !hasControl(value.tool) &&
      typeof value.fingerprint === 'string' &&
      CITATION_FINGERPRINT.test(value.fingerprint) &&
      (value.answer === undefined || sourcePath(value.answer))
    );
  if (value.kind === 'git')
    return (
      typeof value.repo === 'string' &&
      citationUri(value.repo) &&
      typeof value.commit === 'string' &&
      /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value.commit) &&
      (value.path === undefined || sourcePath(value.path))
    );
  return (
    typeof value.sha256 === 'string' &&
    /^[a-fA-F0-9]{64}$/.test(value.sha256) &&
    (value.kind === 'file'
      ? typeof value.path === 'string' && sourcePath(value.path)
      : typeof value.uri === 'string' && citationUri(value.uri))
  );
}

/** Every citation marker produces a result, including unclosed comments. No raw text escapes. */
export function parseCitations(content: string): ParsedCitation[] {
  const markers = [...content.matchAll(/<!--\s*interfacedelta:cite/gi)];
  let previousStart = 0;
  let line = 1;
  let close = content.indexOf('-->');
  return markers.map((marker, index) => {
    const start = marker.index;
    const next = markers[index + 1]?.index ?? content.length;
    if (close >= 0 && close < start) close = content.indexOf('-->', start);
    const closed = close >= 0 && close < next;
    const end = closed ? close + 3 : next;
    line += content.slice(previousStart, start).split('\n').length - 1;
    previousStart = start;
    const location = { start, end, line };
    const malformed = () => ({ ...location, error: 'Malformed citation v1.' });
    if (!closed || !marker[0].endsWith('interfacedelta:cite'))
      return malformed();
    let rest = content.slice(start + marker[0].length, close);
    const attributes: Record<string, string> = Object.create(null);
    while (rest.trim()) {
      const attribute =
        /^\s+([a-z][a-z0-9]*)=(?:"([^"\r\n]*)"|'([^'\r\n]*)')/.exec(rest);
      if (!attribute) return malformed();
      const name = attribute[1]!;
      if (Object.hasOwn(attributes, name)) return malformed();
      attributes[name] = attribute[2] ?? attribute[3]!;
      rest = rest.slice(attribute[0].length);
    }
    const citation = attributes as Citation;
    return validCitation(citation) ? { ...location, citation } : malformed();
  });
}

const labelAttribute = (label: string | undefined): string =>
  label === undefined
    ? ''
    : ` label=${label.includes('"') ? "'" : '"'}${label}${label.includes('"') ? "'" : '"'}`;

export function formatCitation(citation: Citation): string {
  if (!validCitation(citation)) throw new Error('Invalid citation v1.');
  const metadata = `${citation.checked !== undefined ? ` checked="${citation.checked}"` : ''}${labelAttribute(citation.label)}`;
  if (isToolCitation(citation))
    return `<!-- interfacedelta:cite${citation.kind ? ' kind="mcp-tool"' : ''} endpoint="${citation.endpoint}" tool="${citation.tool}" fingerprint="${citation.fingerprint}"${citation.checked !== undefined ? ` checked="${citation.checked}"` : ''}${citation.answer ? ` answer="${citation.answer}"` : ''}${labelAttribute(citation.label)} -->`;
  const source =
    citation.kind === 'file'
      ? `path="${citation.path}" sha256="${citation.sha256}"`
      : citation.kind === 'url'
        ? `uri="${citation.uri}" sha256="${citation.sha256}"`
        : `repo="${citation.repo}" commit="${citation.commit}"${citation.path !== undefined ? ` path="${citation.path}"` : ''}`;
  return `<!-- interfacedelta:cite kind="${citation.kind}" ${source}${metadata} -->`;
}

/** Identity excludes the pinned version so updates replace the previous pin. */
export function citationIdentity(citation: Citation): string {
  if (isToolCitation(citation))
    return JSON.stringify([
      'mcp-tool',
      new URL(citation.endpoint).href,
      citation.tool,
    ]);
  if (citation.kind === 'file') return JSON.stringify(['file', citation.path]);
  if (citation.kind === 'url') return JSON.stringify(['url', citation.uri]);
  return JSON.stringify(['git', citation.repo, citation.path ?? '']);
}
export function citationTarget(citation: Citation): string {
  if (isToolCitation(citation)) return citation.endpoint;
  if (citation.kind === 'file') return citation.path;
  if (citation.kind === 'url') return citation.uri;
  return citation.repo + (citation.path ? `:${citation.path}` : '');
}

/** Move only comments for this source to the top; preserve every other byte. */
export function insertCitation(content: string, citation: Citation): string {
  const parsed = parseCitations(content);
  if (parsed.some((item) => item.error))
    throw new Error('Repair malformed citations before updating this file.');
  let body = content;
  for (const item of parsed.reverse()) {
    if (
      !item.citation ||
      citationIdentity(item.citation) !== citationIdentity(citation)
    )
      continue;
    let end = item.end;
    if (
      (item.start === 0 ||
        (item.start === 1 && body[0] === '\uFEFF') ||
        body[item.start - 1] === '\n') &&
      /^(?:\r\n|\n)/.test(body.slice(end))
    )
      end += body.startsWith('\r\n', end) ? 2 : 1;
    body = body.slice(0, item.start) + body.slice(end);
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const bom = body.startsWith('\uFEFF') ? '\uFEFF' : '';
  return bom + formatCitation(citation) + newline + body.slice(bom.length);
}
