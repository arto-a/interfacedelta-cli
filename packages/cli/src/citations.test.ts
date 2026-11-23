import './test-network-block.cjs';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArguments, HELP } from './arguments';
import { runCite } from './cite';
import {
  formatCitation,
  insertCitation,
  parseCitations,
} from './citation-format';
import { mergeCitationKeys, verifyCitationAnswer } from './citation-signature';
import {
  citationsFailOn,
  citationsToSarif,
  formatCitations,
  runCitations,
  type CitationsReport,
} from './citations';
import {
  citationFixture,
  citationGoal,
  citationKeys,
  citationLine,
  signedCitationAnswer,
} from './citations-fixture';
import { skillFile } from './skills-fixture';
import { runCli } from './run';
import { sanitizeTerminal } from './sanitize';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'citations-'));
  roots.push(root);
  return root;
}
const environment = (answers = [signedCitationAnswer()]) => ({
  env: { INTERFACEDELTA_AGENT_KEY: 'fixture-citation-key' },
  fetch: vi.fn(
    async (url: unknown) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/keys') ? citationKeys : citationGoal(answers),
        ),
      ),
  ),
});

describe('citation v1 parser and insertion', () => {
  it.each([
    '\u2028',
    '\u2029',
    '\u200b',
    '\u200d',
    '\u2066',
    '\u00ad',
    '\u0085',
    '\u{e0001}',
  ])(
    'rejects Unicode control/format/separator characters in tool and label: %j',
    (character) => {
      for (const field of ['tool', 'label']) {
        const citation = {
          ...citationFixture,
          [field]: 'read' + character + 'item',
        };
        expect(() => formatCitation(citation)).toThrow('Invalid citation');
        const line =
          field === 'tool'
            ? citationLine.replace('read_item', citation.tool)
            : citationLine.replace(' -->', ` label="${citation.label}" -->`);
        expect(parseCitations(line)[0]!.error).toBe('Malformed citation v1.');
      }
    },
  );
  it('strips Unicode line/paragraph separators from terminal and SARIF output', () => {
    expect(sanitizeTerminal('before\u2028middle\u2029after')).toBe(
      'beforemiddleafter',
    );
    const report: CitationsReport = {
      formatVersion: 'interfacedelta-citations-v1',
      truncated: false,
      filesRead: 1,
      bytesRead: 1,
      toolsChecked: 0,
      citations: [
        {
          path: 'SKILL.md',
          line: 1,
          status: 'changed',
          citation: { ...citationFixture, tool: 'read\u2028item\u2029' },
        },
      ],
    };
    expect(formatCitations(report)).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.stringify(citationsToSarif(report))).not.toMatch(
      /[\u2028\u2029]/,
    );
  });
  it('replaces case-normalized endpoint duplicates while preserving the chosen spelling', () => {
    const upper = { ...citationFixture, endpoint: 'https://TOOLS.example/mcp' };
    const lower = { ...citationFixture, endpoint: 'https://tools.example/mcp' };
    const updated = insertCitation(
      formatCitation(upper) + '\n' + formatCitation(lower) + '\n# Skill\n',
      lower,
    );
    expect(updated).toBe(formatCitation(lower) + '\n# Skill\n');
    expect(parseCitations(updated)).toHaveLength(1);
    expect(formatCitation(upper)).toContain(upper.endpoint);
  });

  it.each([
    citationLine,
    citationLine.replace('checked="2026-11-22"', ''),
    citationLine.replaceAll('"', "'"),
    citationLine.replace(
      'endpoint=',
      'answer=".interfacedelta/citations/a.json" endpoint=',
    ),
    citationLine.replace('tool="read_item"', 'tool="read item"'),
    citationLine.replace('checked="2026-11-22"', 'checked="2024-02-29"'),
  ])('accepts strict quoted attributes: %s', (line) => {
    expect(parseCitations('private\n' + line)[0]).toMatchObject({
      line: 2,
      citation: { endpoint: citationFixture.endpoint },
    });
    expect(JSON.stringify(parseCitations(line))).not.toContain('private');
  });
  it.each([
    citationLine.replace('https:', 'http:'),
    citationLine.replace('https://', 'https://user:pass@'),
    citationLine.replace('/mcp"', '/mcp?token=private"'),
    citationLine.replace('/mcp"', '/mcp?"'),
    citationLine.replace('/mcp"', '/mcp#"'),
    citationLine.replace('tool="read_item"', 'tool=read_item'),
    citationLine.replace('tool="read_item"', 'Tool="read_item"'),
    citationLine.replace('cite ', 'citeendpoint '),
    citationLine.replace('interfacedelta:cite', 'InterfaceDelta:Cite'),
    citationLine.replace('tool="read_item"', 'tool="read_item" tool="other"'),
    citationLine.replace('tool="read_item"', 'tool=""'),
    citationLine.replace('checked=', 'extra="private" checked='),
    citationLine.replace('checked="2026-11-22"', 'checked="2026-02-30"'),
    citationLine.replace('sha256:', 'md5:'),
    citationLine.replace('a'.repeat(64), 'a'.repeat(63)),
    citationLine.replace(' -->', ' answer="../outside.json" -->'),
    citationLine.replace(' -->', ' answer="/outside.json" -->'),
    citationLine.replace(' -->', ' answer="a\\b.json" -->'),
    citationLine.replace(' -->', ' answer="https://host/a.json" -->'),
    citationLine.replace(' -->', ''),
    '<!-- interfacedelta:cite -->',
  ])('reports malformed citations without their text: %s', (line) => {
    expect(parseCitations(line)).toEqual([
      { start: 0, end: line.length, line: 1, error: 'Malformed citation v1.' },
    ]);
  });
  it('reports an unclosed marker and recovers the following citation', () => {
    const results = parseCitations(
      '<!-- interfacedelta:cite private\n' + citationLine,
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.error).toBeTruthy();
    expect(results[1]!.citation).toEqual(citationFixture);
  });
  it.each(['\n', '\r\n'])(
    'inserts and updates byte-idempotently preserving %j and unrelated bytes',
    (newline) => {
      const original = `# Private instructions${newline}Use read_item.${newline}`;
      const inserted = insertCitation(original, citationFixture);
      expect(insertCitation(inserted, citationFixture)).toBe(inserted);
      expect(inserted).toBe(citationLine + newline + original);
      const changed = {
        ...citationFixture,
        fingerprint: 'sha256:' + 'b'.repeat(64),
      };
      expect(insertCitation(inserted, changed)).toBe(
        formatCitation(changed) + newline + original,
      );
      const other = formatCitation({
        ...citationFixture,
        endpoint: 'https://other.example/mcp',
      });
      expect(insertCitation(other + newline + inserted, changed)).toBe(
        formatCitation(changed) + newline + other + newline + original,
      );
    },
  );
  it('preserves inline text and a UTF-8 BOM, and refuses ambiguous malformed edits', () => {
    expect(
      insertCitation('before ' + citationLine + ' after', citationFixture),
    ).toBe(citationLine + '\nbefore  after');
    const bom = insertCitation('\uFEFF# Skill\r\n', citationFixture);
    expect(insertCitation(bom, citationFixture)).toBe(bom);
    expect(() =>
      insertCitation('<!-- interfacedelta:cite private -->', citationFixture),
    ).toThrow('malformed');
  });
});

describe('offline citation signature verification', () => {
  it('rejects a published JWK that contains private material', () => {
    const pair = generateKeyPairSync('ed25519');
    expect(
      verifyCitationAnswer(signedCitationAnswer(), {
        keys: [
          {
            ...citationKeys.keys[0],
            d: pair.privateKey.export({ format: 'jwk' }).d,
          },
        ],
      }),
    ).toBe(false);
  });
  it('sorts merged kids, never drops old keys, and refuses ambiguous or changed keys', () => {
    const k1 = { ...citationKeys.keys[0], kid: 'z-old' };
    const k2 = { ...citationKeys.keys[0], kid: 'a-new' };
    expect(mergeCitationKeys({ keys: [k1] }, { keys: [k2] })).toEqual({
      keys: [k2, k1],
    });
    expect(mergeCitationKeys({ keys: [k1] }, { keys: [] })).toEqual({
      keys: [k1],
    });
    expect(() =>
      mergeCitationKeys({ keys: [k1] }, { keys: [{ ...k1, x: 'different' }] }),
    ).toThrow('material changed');
    for (const snapshot of [
      {},
      { keys: [k1, k1] },
      { keys: [{ ...k1, d: 'private' }] },
    ])
      expect(() => mergeCitationKeys(snapshot, { keys: [k2] })).toThrow();
  });

  it('verifies fixture Ed25519 JWS and authenticates every signed field', () => {
    const answer = signedCitationAnswer();
    expect(verifyCitationAnswer(answer, citationKeys)).toBe(true);
    expect(
      verifyCitationAnswer(
        { ...answer, issuedAt: '2026-11-23T00:00:00Z' },
        citationKeys,
      ),
    ).toBe(false);
    expect(
      verifyCitationAnswer(
        { ...answer, changedSinceTime: false },
        citationKeys,
      ),
    ).toBe(false);
    expect(verifyCitationAnswer(answer, { keys: [] })).toBe(false);
    expect(
      verifyCitationAnswer(answer, {
        keys: [...citationKeys.keys, ...citationKeys.keys],
      }),
    ).toBe(false);
    expect(
      verifyCitationAnswer(answer, {
        keys: [{ ...citationKeys.keys[0], alg: 'HS256' }],
      }),
    ).toBe(false);
    expect(
      verifyCitationAnswer(answer, {
        keys: [{ ...citationKeys.keys[0], x: 'a'.repeat(43) }],
      }),
    ).toBe(false);
  });
  it.each([
    'bad',
    'header.payload.signature',
    Buffer.from(
      JSON.stringify({
        alg: 'HS256',
        kid: 'citation-fixture',
        typ: 'interfacedelta-record-check+jws',
      }),
    ).toString('base64url') +
      '..' +
      'a'.repeat(86),
    Buffer.from(
      JSON.stringify({ alg: 'EdDSA', kid: 'citation-fixture', typ: 'wrong' }),
    ).toString('base64url') +
      '..' +
      'a'.repeat(86),
  ])('rejects invalid JWS %s', (jws) => {
    expect(
      verifyCitationAnswer(
        {
          ...signedCitationAnswer(),
          signature: {
            jws,
            verify: 'https://interfacedelta.com/api/v1/record/check/verify',
          },
        },
        citationKeys,
      ),
    ).toBe(false);
  });
});

describe('cite command', () => {
  it('retains A signed with K1 after citing B when only K2 is published', async () => {
    const root = await workspace();
    await skillFile(root, 'A.md', '# A');
    await skillFile(root, 'B.md', '# B');
    const a = await runCite(
      { ...citationFixture, file: join(root, 'A.md') },
      environment(),
    );
    const pair = generateKeyPairSync('ed25519');
    const k2 = {
      ...pair.publicKey.export({ format: 'jwk' }),
      kid: 'rotation-k2',
      alg: 'EdDSA',
      use: 'sig',
    };
    const bAnswer = signedCitationAnswer(
      { tool: { name: 'other_tool' } },
      { privateKey: pair.privateKey, kid: k2.kid },
    );
    const env = environment([bAnswer]);
    env.fetch = vi.fn(
      async (url: unknown) =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/keys')
              ? { keys: [k2] }
              : citationGoal([bAnswer]),
          ),
        ),
    );
    await runCite(
      {
        endpoint: citationFixture.endpoint,
        tool: 'other_tool',
        file: join(root, 'B.md'),
      },
      env,
    );
    const snapshot = JSON.parse(
      await readFile(join(root, '.interfacedelta/citations/keys.json'), 'utf8'),
    );
    expect(snapshot.keys.map((key: { kid: string }) => key.kid)).toEqual([
      'citation-fixture',
      'rotation-k2',
    ]);
    expect(
      verifyCitationAnswer(
        JSON.parse(await readFile(join(root, a.citation.answer!), 'utf8')),
        snapshot,
      ),
    ).toBe(true);
    const checked = await runCitations(
      { dir: root, include: ['A.md', 'B.md'] },
      environment([signedCitationAnswer(), bAnswer]),
    );
    expect(
      checked.report.citations.map(({ signature, status }) => ({
        signature,
        status,
      })),
    ).toEqual([
      { signature: 'valid', status: 'current' },
      { signature: 'valid', status: 'current' },
    ]);
  });
  it('fetches the keys from the --api-url origin', async () => {
    const root = await workspace();
    await skillFile(root, 'SKILL.md', '# Skill');
    const env = environment();
    const stdout = vi.fn(),
      stderr = vi.fn();
    expect(
      await runCli(
        [
          'cite',
          citationFixture.endpoint,
          citationFixture.tool,
          '--file',
          join(root, 'SKILL.md'),
          '--api-url',
          'https://record.example',
        ],
        { stdout, stderr, status: env },
      ),
    ).toBe(0);
    expect(env.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://record.example/api/v1/record/check/goal',
      'https://record.example/api/v1/record/check/keys',
    ]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('stores a verified signed answer and keys beside the file, and updates idempotently with CRLF', async () => {
    const root = await workspace();
    const path = join(root, 'nested/SKILL.md');
    await skillFile(
      root,
      'nested/SKILL.md',
      '# Private skill\r\nUse read_item.\r\n',
    );
    const env = environment();
    const args = { ...citationFixture, file: path };
    const first = await runCite(args, env, new Date('2026-11-22T12:00:00Z'));
    const contents = await readFile(path, 'utf8');
    await runCite(args, env, new Date('2026-11-22T13:00:00Z'));
    expect(await readFile(path, 'utf8')).toBe(contents);
    expect(contents).toBe(
      first.output.trimEnd() + '\r\n# Private skill\r\nUse read_item.\r\n',
    );
    const answer = JSON.parse(
      await readFile(join(root, 'nested', first.citation.answer!), 'utf8'),
    );
    expect(verifyCitationAnswer(answer, citationKeys)).toBe(true);
    expect(answer).not.toHaveProperty('changedSinceTime');
    expect(
      JSON.parse(
        await readFile(
          join(root, 'nested/.interfacedelta/citations/keys.json'),
          'utf8',
        ),
      ),
    ).toEqual(citationKeys);
    const checked = await runCitations({ dir: root }, env);
    expect(checked.report.citations[0]).toMatchObject({
      path: 'nested/SKILL.md',
      status: 'current',
      signature: 'valid',
    });
    for (const [url] of env.fetch.mock.calls)
      expect(String(url)).toMatch(/^https:\/\/interfacedelta.com\//);
  });
  it('verifies keyless MCP tool bodies after removing only the unsigned goal flag', async () => {
    const root = await workspace();
    await skillFile(root, 'SKILL.md', '# Skill');
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('/keys'))
        return new Response(JSON.stringify(citationKeys));
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result:
            rpc.method === 'initialize'
              ? { protocolVersion: '2025-03-26' }
              : {
                  structuredContent: {
                    result: citationGoal(),
                    quota: { keyless: true },
                  },
                },
        }),
      );
    });
    expect(
      (
        await runCite(
          { ...citationFixture, file: join(root, 'SKILL.md') },
          { env: {}, fetch: fetcher },
        )
      ).citation.answer,
    ).toMatch(/\.json$/);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('prints and saves without --file in cwd', async () => {
    const root = await workspace();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const result = await runCite(citationFixture, environment());
    expect(parseCitations(result.output)[0]!.citation).toEqual(result.citation);
    expect(
      await readFile(join(root, result.citation.answer!), 'utf8'),
    ).toContain('recordCheck');
  });
  it.each(['unavailable', 'oversized', 'invalid JSON', 'wrong keys'])(
    'refuses %s public keys without writing evidence or instructions',
    async (kind) => {
      const root = await workspace();
      const file = join(root, 'SKILL.md');
      await skillFile(root, 'SKILL.md', '# Original');
      const env = environment();
      env.fetch = vi.fn(async (url: unknown) => {
        if (!String(url).endsWith('/keys'))
          return new Response(JSON.stringify(citationGoal()));
        return kind === 'unavailable'
          ? new Response('private response', { status: 503 })
          : new Response(
              kind === 'oversized'
                ? 'x'.repeat(1024 * 1024 + 1)
                : kind === 'invalid JSON'
                  ? 'private response'
                  : '{"keys":[]}',
            );
      });
      await expect(
        runCite({ ...citationFixture, file }, env),
      ).rejects.toMatchObject({ exitCode: 3 });
      expect(await readFile(file, 'utf8')).toBe('# Original');
      await expect(
        readFile(join(root, '.interfacedelta/citations/keys.json')),
      ).rejects.toThrow();
    },
  );
  it('refuses to retain a signed answer that echoes the request credential', async () => {
    const root = await workspace();
    const file = join(root, 'SKILL.md');
    await skillFile(root, 'SKILL.md', '# Original');
    await expect(
      runCite(
        { ...citationFixture, file },
        environment([signedCitationAnswer({ echoed: 'fixture-citation-key' })]),
      ),
    ).rejects.toThrow('would contain the credential');
    expect(await readFile(file, 'utf8')).toBe('# Original');
    await expect(
      readFile(join(root, '.interfacedelta/citations/keys.json')),
    ).rejects.toThrow();
  });
  it('refuses invalid signatures, missing observations, and wrong tool identities without modifying the skill', async () => {
    const root = await workspace();
    const file = join(root, 'SKILL.md');
    await skillFile(root, 'SKILL.md', '# Original');
    for (const answer of [
      { ...signedCitationAnswer(), issuedAt: 'tampered' },
      signedCitationAnswer({ status: 'removed' }),
      signedCitationAnswer({ tool: { name: 'wrong' } }),
      signedCitationAnswer({ change: { fingerprint: 'bad', last: null } }),
    ])
      await expect(
        runCite({ ...citationFixture, file }, environment([answer])),
      ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('# Original');
  });
  it('refuses malformed files, unsafe endpoints, symlink files and output directories before writes', async () => {
    const root = await workspace();
    const other = await workspace();
    const file = join(root, 'SKILL.md');
    const env = environment();
    await skillFile(root, 'SKILL.md', '<!-- interfacedelta:cite -->');
    await expect(runCite({ ...citationFixture, file }, env)).rejects.toThrow(
      'malformed',
    );
    await expect(
      runCite({ ...citationFixture, endpoint: 'http://host/mcp', file }, env),
    ).rejects.toThrow('HTTPS');
    expect(env.fetch).not.toHaveBeenCalled();
    await symlink(file, join(root, 'AGENTS.md'));
    await expect(
      runCite({ ...citationFixture, file: join(root, 'AGENTS.md') }, env),
    ).rejects.toThrow('symlink');
    await skillFile(root, 'SKILL.md', '# Original');
    await symlink(other, join(root, '.interfacedelta'));
    await expect(runCite({ ...citationFixture, file }, env)).rejects.toThrow(
      'symlink',
    );
    expect(await readFile(file, 'utf8')).toBe('# Original');
  });
});

describe('citations checker', () => {
  it.each([
    ['current', {}],
    [
      'changed',
      {
        change: {
          fingerprint: 'sha256:' + 'b'.repeat(64),
          last: { class: 'breaking', at: '2026-11-22T09:00:00Z' },
        },
      },
    ],
    ['removed', { status: 'removed' }],
    ['not_observed', { status: 'not_observed' }],
    ['not_observed', { status: 'requires_sign_in' }],
  ])('reports %s without line text', async (status, overrides) => {
    const root = await workspace();
    await skillFile(
      root,
      'SKILL.md',
      'private instructions\n' + citationLine + '\n',
    );
    const result = await runCitations(
      { dir: root, json: true },
      environment([signedCitationAnswer(overrides)]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.report.citations[0]).toMatchObject({
      path: 'SKILL.md',
      line: 2,
      status,
    });
    if (status === 'changed')
      expect(result.report.citations[0]).toMatchObject({
        changeClass: 'breaking',
        changedAt: '2026-11-22T09:00:00Z',
      });
    expect(result.output).not.toContain('private instructions');
  });
  it('reports malformed markers without network and gates only explicit statuses', async () => {
    const root = await workspace();
    await skillFile(root, 'AGENTS.md', '<!-- interfacedelta:cite PRIVATE -->');
    const env = environment();
    const result = await runCitations(
      { dir: root, failOn: 'malformed', json: true },
      env,
    );
    expect(result.exitCode).toBe(1);
    expect(result.report.citations).toEqual([
      { path: 'AGENTS.md', line: 1, status: 'malformed' },
    ]);
    expect(result.output).not.toContain('PRIVATE');
    expect(env.fetch).not.toHaveBeenCalled();
    expect((await runCitations({ dir: root }, env)).exitCode).toBe(0);
    expect(() => citationsFailOn('not_observed')).toThrow();
  });
  it('deduplicates tools, matches each pinned fingerprint and preserves unclassified changes', async () => {
    const root = await workspace();
    await skillFile(
      root,
      'AGENTS.md',
      citationLine +
        '\n' +
        formatCitation({
          ...citationFixture,
          fingerprint: 'sha256:' + 'b'.repeat(64),
        }),
    );
    const env = environment();
    const result = await runCitations({ dir: root, failOn: 'changed' }, env);
    expect(result.report.toolsChecked).toBe(1);
    expect(result.report.citations.map((item) => item.status)).toEqual([
      'current',
      'changed',
    ]);
    expect(result.report.citations[1]).not.toHaveProperty('changeClass');
    expect(result.exitCode).toBe(1);
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });
  it('verifies local evidence offline, rejects tampering and binding mismatches, and never follows answer URLs', async () => {
    const root = await workspace();
    const env = environment();
    await skillFile(
      root,
      '.interfacedelta/citations/keys.json',
      JSON.stringify(citationKeys),
    );
    await skillFile(
      root,
      'AGENTS.md',
      formatCitation({
        ...citationFixture,
        answer: '.interfacedelta/citations/answer.json',
      }),
    );
    for (const answer of [
      { ...signedCitationAnswer(), issuedAt: 'changed' },
      signedCitationAnswer({ status: 'removed' }),
      signedCitationAnswer({ status: 'not_observed' }),
      signedCitationAnswer({ status: 'requires_sign_in' }),
      signedCitationAnswer({ tool: { name: 'other' } }),
      signedCitationAnswer({
        change: { fingerprint: 'sha256:' + 'b'.repeat(64), last: null },
      }),
    ]) {
      if (answer.status !== 'observed')
        expect(verifyCitationAnswer(answer, citationKeys)).toBe(true);
      await skillFile(
        root,
        '.interfacedelta/citations/answer.json',
        JSON.stringify(answer),
      );
      const result = await runCitations(
        { dir: root, failOn: 'signature_invalid' },
        env,
      );
      expect(result.exitCode).toBe(1);
      expect(result.report.citations[0]).toMatchObject({
        status: 'signature_invalid',
        signature: 'invalid',
      });
    }
    expect(env.fetch).not.toHaveBeenCalled();
    await skillFile(
      root,
      '.interfacedelta/citations/answer.json',
      JSON.stringify(signedCitationAnswer()),
    );
    expect(
      (await runCitations({ dir: root }, env)).report.citations[0]!.signature,
    ).toBe('valid');
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });
  it('uses explicit trusted published keys and reports missing or symlinked evidence as invalid', async () => {
    const root = await workspace();
    await skillFile(
      root,
      'SKILL.md',
      formatCitation({
        ...citationFixture,
        answer: '.interfacedelta/citations/answer.json',
      }),
    );
    const args = { dir: root, keys: 'trusted-keys.json' };
    const env = environment();
    expect((await runCitations(args, env)).report.citations[0]!.status).toBe(
      'signature_invalid',
    );
    await skillFile(root, 'trusted-keys.json', JSON.stringify(citationKeys));
    await skillFile(
      root,
      'outside.json',
      JSON.stringify(signedCitationAnswer()),
    );
    await skillFile(root, '.interfacedelta/citations/placeholder.json', '{}');
    await symlink(
      join(root, 'outside.json'),
      join(root, '.interfacedelta/citations/answer.json'),
    );
    expect((await runCitations(args, env)).report.citations[0]!.status).toBe(
      'signature_invalid',
    );
    expect(env.fetch).not.toHaveBeenCalled();
    await rm(join(root, '.interfacedelta/citations/answer.json'));
    await skillFile(
      root,
      '.interfacedelta/citations/answer.json',
      JSON.stringify(signedCitationAnswer()),
    );
    expect((await runCitations(args, env)).report.citations[0]!.signature).toBe(
      'valid',
    );
  });
  it('reuses include rules and scan caps and marks omitted citations', async () => {
    const root = await workspace();
    await skillFile(root, 'custom.md', citationLine);
    await skillFile(root, 'SKILL.md', citationLine + '\n' + citationLine);
    const env = environment();
    expect(
      (await runCitations({ dir: root, include: ['custom.md'] }, env)).report
        .citations,
    ).toHaveLength(3);
    const result = await runCitations(
      { dir: root, limits: { maxTotal: 1 } },
      env,
    );
    expect(result.report.truncated).toBe(true);
    expect(result.report.citations).toHaveLength(1);
  });
  it('rejects wrong current identities and bad fingerprints as record errors', async () => {
    const root = await workspace();
    await skillFile(root, 'SKILL.md', citationLine);
    for (const overrides of [
      { tool: { name: 'other' } },
      { change: { fingerprint: 'bad', last: null } },
    ])
      await expect(
        runCitations(
          { dir: root },
          environment([signedCitationAnswer(overrides)]),
        ),
      ).rejects.toThrow('mismatched');
  });
  it('uses CLI exit codes for thresholds, invalid options and record failures', async () => {
    const root = await workspace();
    await skillFile(root, 'SKILL.md', citationLine);
    const stdout = vi.fn(),
      stderr = vi.fn();
    const status = environment([signedCitationAnswer({ status: 'removed' })]);
    expect(
      await runCli(['citations', root, '--fail-on', 'removed'], {
        stdout,
        stderr,
        status,
      }),
    ).toBe(1);
    expect(
      await runCli(['citations', root, '--fail-on', 'unknown'], {
        stdout,
        stderr,
        status,
      }),
    ).toBe(2);
    expect(
      await runCli(['citations', root], {
        stdout,
        stderr,
        status: {
          ...status,
          fetch: vi.fn(async () => new Response('{}', { status: 503 })),
        },
      }),
    ).toBe(3);
    expect(
      await runCli(
        [
          'cite',
          citationFixture.endpoint,
          citationFixture.tool,
          '--file',
          join(root, 'SKILL.md'),
        ],
        {
          stdout,
          stderr,
          status: environment(),
          now: () => new Date('2026-11-22T00:00:00Z'),
        },
      ),
    ).toBe(0);
    for (const argv of [
      ['cite'],
      ['cite', 'a', 'b', 'c'],
      ['citations', 'a', 'b'],
      ['cite', 'a', 'b', '--file'],
      ['citations', '--sarif'],
      ['citations', '--token', 'x'],
    ])
      expect(() => parseArguments(argv)).toThrow();
    expect(
      parseArguments([
        'citations',
        root,
        '--include',
        '*.md',
        '--keys',
        'keys.json',
      ]),
    ).toMatchObject({
      command: 'citations',
      skillsDir: root,
      skillIncludes: ['*.md'],
      citationKeys: 'keys.json',
    });
    expect(HELP).toContain('interfacedelta-citations-v1');
  });
});

describe('citations golden output and SARIF paths', () => {
  const report: CitationsReport = {
    formatVersion: 'interfacedelta-citations-v1',
    truncated: false,
    filesRead: 1,
    bytesRead: 250,
    toolsChecked: 1,
    citations: [
      {
        path: 'rules/a #%.md',
        line: 2,
        status: 'changed',
        citation: citationFixture,
        currentFingerprint: 'sha256:' + 'b'.repeat(64),
        changeClass: 'breaking',
        changedAt: '2026-11-22T09:00:00Z',
      },
      { path: 'AGENTS.md', line: 1, status: 'malformed' },
    ],
  };
  it('has stable table, JSON and SARIF output', () => {
    expect(formatCitations(report)).toMatchSnapshot();
    expect(JSON.stringify(report, null, 2)).toMatchSnapshot();
    expect(citationsToSarif(report)).toMatchSnapshot();
  });
  it.each(['project', 'deep/checkout/project'])(
    'produces the same root-relative SARIF at %s directory depth',
    async (depth) => {
      const root = await workspace();
      await skillFile(
        root,
        `${depth}/prompts/team/SKILL.md`,
        '<!-- interfacedelta:cite private -->',
      );
      const sarif = join(root, 'out.sarif');
      const result = await runCitations(
        { dir: join(root, depth), sarif },
        environment(),
      );
      const log = JSON.parse(await readFile(sarif, 'utf8'));
      expect(log).toEqual(citationsToSarif(result.report));
      const uri =
        log.runs[0].results[0].locations[0].physicalLocation.artifactLocation
          .uri;
      expect(uri).toBe('prompts/team/SKILL.md');
      expect(uri).not.toContain('..');
      expect(JSON.stringify(log)).not.toContain(root);
    },
  );
  it('rejects absolute, traversal and Windows paths rather than emitting unsafe URIs', () => {
    for (const path of [
      '/tmp/SKILL.md',
      '../SKILL.md',
      'a/../SKILL.md',
      'a\\SKILL.md',
    ])
      expect(() =>
        citationsToSarif({
          ...report,
          citations: [{ ...report.citations[0]!, path }],
        }),
      ).toThrow('root-relative');
    expect(
      citationsToSarif({ ...report, truncated: true }).runs[0]!.invocations[0]!
        .toolExecutionNotifications,
    ).toHaveLength(1);
  });
});
