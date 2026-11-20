import * as fs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computePassportFingerprint } from '@interfacedelta/core';
import { runCli } from './run';
import {
  DEFAULT_LIKELY_USES_LIMITS,
  matchesWholeIdentifier,
  scanLikelyUses,
} from './likely-uses';
import { passportFixture } from './test-fixture';
import type { CheckResult } from './types';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readdir: vi.fn(actual.readdir),
  };
});

const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Only the fields the scanner reads; the rest of CheckResult is irrelevant. */
const resultWith = (
  changes: {
    semanticId?: string;
    code?: string;
    entityId?: string;
    path?: string;
    action?: 'block' | 'warn' | 'allow';
  }[],
  subjects: Record<string, { kind: string; name: string }> = {},
): CheckResult =>
  ({
    comparison: {
      changes: changes.map((item, index) => ({
        semanticId: item.semanticId ?? `change:${index}`,
        code: item.code ?? 'CAPABILITY_REMOVED',
        classification: 'breaking',
        entityKind: 'capability',
        entityId: item.entityId ?? 'capability:search_code',
        path: item.path ?? '$',
        reasonCode: 'PREVIOUSLY_PRESENT_CURRENTLY_ABSENT_COMPLETE_INVENTORIES',
        before: null,
        after: null,
      })),
    },
    decisions: changes.map((item, index) => ({
      change: `change:${index}`,
      action: item.action ?? 'block',
      source: 'policy',
      card: { attention: 'fix', domains: [], step: 'Regenerate the baseline.' },
    })),
    subjects,
  }) as unknown as CheckResult;

const toolResult = (name: string, action: 'block' | 'warn' = 'block') =>
  resultWith([{ entityId: `capability:${name}`, action }], {
    [`capability:${name}`]: { kind: 'mcp.tool', name },
  });

const write = async (path: string, content: string | Buffer) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

describe('whole-identifier matching', () => {
  it('requires identifier boundaries on both sides', () => {
    expect(
      matchesWholeIdentifier('create_pull_request()', 'create_pull_request'),
    ).toBe(true);
    expect(
      matchesWholeIdentifier('x.create_pull_request;', 'create_pull_request'),
    ).toBe(true);
    expect(
      matchesWholeIdentifier('call create-pull_request', 'create_pull_request'),
    ).toBe(false);
    expect(
      matchesWholeIdentifier('create_pull_request_v2()', 'create_pull_request'),
    ).toBe(false);
    expect(
      matchesWholeIdentifier('my_create_pull_request()', 'create_pull_request'),
    ).toBe(false);
    expect(
      matchesWholeIdentifier('CREATE_PULL_REQUEST()', 'create_pull_request'),
    ).toBe(false);
    expect(matchesWholeIdentifier('search', 'search')).toBe(true);
  });

  it('finds a whole identifier but not its longer cousins in files', async () => {
    const root = await tempDir('interfacedelta-uses-match-');
    await write(
      join(root, 'caller.ts'),
      [
        'client.callTool("create_pull_request", {});',
        'client.callTool("create_pull_request_v2", {});',
        'const renamed = my_create_pull_request;',
      ].join('\n'),
    );
    const [report] = await scanLikelyUses(root, [
      toolResult('create_pull_request'),
    ]);
    expect(report).toEqual({
      truncated: false,
      changes: [
        {
          change: 'change:0',
          uses: [{ term: 'create_pull_request', path: 'caller.ts', line: 1 }],
        },
      ],
    });
  });
});

describe('likely-uses scanner', () => {
  it('rejects a symlinked root before opening any file', async () => {
    const parent = await tempDir('interfacedelta-uses-root-link-');
    const outside = await tempDir('interfacedelta-uses-outside-');
    await write(join(outside, 'outside.ts'), 'search_code();\n');
    const root = join(parent, 'repo');
    await symlink(outside, root, 'dir');
    await expect(
      scanLikelyUses(root, [toolResult('search_code')]),
    ).rejects.toThrow('root must be a directory, not a symlink');
    expect(fs.open).not.toHaveBeenCalled();
  });

  it('does not read a file swapped for a symlink immediately before open', async () => {
    const root = await tempDir('interfacedelta-uses-file-swap-');
    const outside = await tempDir('interfacedelta-uses-outside-');
    const candidate = join(root, 'caller.ts');
    const target = join(outside, 'outside.ts');
    await write(candidate, '// no match\n');
    await write(target, 'search_code();\n');
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
      expect(path).toBe(candidate);
      await rm(candidate);
      await symlink(target, candidate);
      return actual.open(path, flags, mode);
    });
    const [report] = await scanLikelyUses(root, [toolResult('search_code')]);
    expect(fs.open).toHaveBeenCalledOnce();
    expect(report?.changes[0]?.uses).toEqual([]);
  });

  it('does not descend into a directory swapped for a symlink after listing', async () => {
    const root = await tempDir('interfacedelta-uses-dir-swap-');
    const outside = await tempDir('interfacedelta-uses-outside-');
    const candidate = join(root, 'src');
    await mkdir(candidate);
    await write(join(outside, 'outside.ts'), 'search_code();\n');
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.readdir).mockImplementationOnce(async (path, options) => {
      const entries = await actual.readdir(path, options);
      await rename(candidate, join(root, 'moved'));
      await symlink(outside, candidate, 'dir');
      return entries;
    });
    const [report] = await scanLikelyUses(root, [toolResult('search_code')]);
    expect(fs.readdir).toHaveBeenCalledOnce();
    expect(fs.open).not.toHaveBeenCalled();
    expect(report?.changes[0]?.uses).toEqual([]);
  });

  it('does not read through a parent swapped for a symlink at file open', async () => {
    const root = await tempDir('interfacedelta-uses-parent-swap-');
    const outside = await tempDir('interfacedelta-uses-outside-');
    const candidate = join(root, 'src');
    await write(join(candidate, 'caller.ts'), '// no match\n');
    await write(join(outside, 'caller.ts'), 'search_code();\n');
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
      await rename(candidate, join(root, 'moved'));
      await symlink(outside, candidate, 'dir');
      const handle = await actual.open(path, flags, mode);
      vi.spyOn(handle, 'read');
      vi.spyOn(handle, 'close');
      return handle;
    });
    const [report] = await scanLikelyUses(root, [toolResult('search_code')]);
    const handle = await vi.mocked(fs.open).mock.results[0]!.value;
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(report?.changes[0]?.uses).toEqual([]);
  });

  it('never follows symlinks', async () => {
    const root = await tempDir('interfacedelta-uses-link-');
    await write(join(root, 'real', 'nested.ts'), 'search_code();\n');
    await write(join(root, 'target.ts'), 'search_code();\n');
    await symlink(join(root, 'real'), join(root, 'link-dir'));
    await symlink(join(root, 'target.ts'), join(root, 'link-file.ts'));
    const [report] = await scanLikelyUses(root, [toolResult('search_code')]);
    expect(report?.changes[0]?.uses.map((use) => use.path)).toEqual([
      'real/nested.ts',
      'target.ts',
    ]);
  });

  it('skips build, dependency and tool directories', async () => {
    const root = await tempDir('interfacedelta-uses-skip-');
    for (const dir of [
      'node_modules',
      '.git',
      'dist',
      'build',
      'out',
      'vendor',
      '.next',
      'coverage',
      '.venv',
      '__pycache__',
      '.interfacedelta',
    ])
      await write(join(root, dir, 'file.ts'), 'search_code();\n');
    await write(join(root, 'src', 'kept.ts'), 'search_code();\n');
    const [report] = await scanLikelyUses(root, [toolResult('search_code')]);
    expect(report?.changes[0]?.uses.map((use) => use.path)).toEqual([
      'src/kept.ts',
    ]);
  });

  it('reads only text files, including mcp.json, and skips binary and oversize files', async () => {
    const root = await tempDir('interfacedelta-uses-files-');
    await write(join(root, 'note.md'), 'search_code\n');
    await write(join(root, 'mcp.json'), '{"tools": ["search_code"]}\n');
    await write(
      join(root, 'binary.ts'),
      Buffer.from('const nul = "\0"; search_code();\n'),
    );
    await write(
      join(root, 'oversize.ts'),
      Buffer.concat([
        Buffer.from('search_code();\n'),
        Buffer.alloc(1024 * 1024, 0x61),
      ]),
    );
    const [report] = await scanLikelyUses(root, [toolResult('search_code')]);
    expect(report?.changes[0]?.uses.map((use) => use.path)).toEqual([
      'mcp.json',
    ]);
  });

  it('stops at the file and byte caps and reports truncated', async () => {
    const root = await tempDir('interfacedelta-uses-caps-');
    await write(join(root, 'a.ts'), 'search_code();\n');
    await write(join(root, 'b.ts'), 'search_code();\n');
    await write(join(root, 'c.ts'), 'search_code();\n');
    const [fileCapped] = await scanLikelyUses(
      root,
      [toolResult('search_code')],
      { maxFiles: 2 },
    );
    expect(fileCapped).toMatchObject({ truncated: true });
    expect(fileCapped?.changes[0]?.uses.map((use) => use.path)).toEqual([
      'a.ts',
      'b.ts',
    ]);
    const [exact] = await scanLikelyUses(root, [toolResult('search_code')], {
      maxFiles: 3,
    });
    expect(exact).toMatchObject({ truncated: false });
    const [byteCapped] = await scanLikelyUses(
      root,
      [toolResult('search_code')],
      { maxBytes: 'search_code();\n'.length },
    );
    expect(byteCapped).toMatchObject({ truncated: true });
    expect(byteCapped?.changes[0]?.uses.map((use) => use.path)).toEqual([
      'a.ts',
    ]);
  });

  it('caps locations per change and in total', async () => {
    const root = await tempDir('interfacedelta-uses-limit-');
    const lines = Array.from(
      { length: 6 },
      (_, n) => `alpha_tool(); beta_tool(); // ${n}`,
    );
    await write(join(root, 'calls.ts'), `${lines.join('\n')}\n`);
    const [perChange] = await scanLikelyUses(root, [toolResult('alpha_tool')], {
      maxPerChange: 2,
    });
    expect(perChange?.changes[0]?.uses).toHaveLength(2);
    expect(perChange?.truncated).toBe(false);
    const totalReports = await scanLikelyUses(
      root,
      [toolResult('alpha_tool'), toolResult('beta_tool')],
      { maxTotal: 3 },
    );
    expect(
      totalReports.flatMap((report) =>
        report ? report.changes.flatMap((change) => change.uses) : [],
      ),
    ).toHaveLength(3);
    expect(totalReports[0]?.truncated).toBe(false);
  });

  it('checks the 20-per-change cap between two terms on the boundary line', async () => {
    const root = await tempDir('interfacedelta-uses-two-terms-');
    await write(
      join(root, 'calls.ts'),
      `${'alpha_tool();\n'.repeat(19)}alpha_tool(currency);\n`,
    );
    const [report] = await scanLikelyUses(root, [
      resultWith([{ path: '$/properties/currency' }], {
        'capability:search_code': { kind: 'mcp.tool', name: 'alpha_tool' },
      }),
    ]);
    expect(report?.changes[0]?.uses).toHaveLength(20);
    expect(report?.changes[0]?.uses.at(-1)).toEqual({
      term: 'alpha_tool',
      path: 'calls.ts',
      line: 20,
    });
  });

  it('checks the 200-total cap between two terms on the boundary line', async () => {
    const root = await tempDir('interfacedelta-uses-total-terms-');
    const names = Array.from({ length: 10 }, (_, index) => `tool_${index}`);
    await write(
      join(root, 'calls.ts'),
      `${names
        .slice(0, 9)
        .map((name) => `${name}();\n`.repeat(20))
        .join('')}${'tool_9();\n'.repeat(19)}tool_9(currency);\n`,
    );
    const reports = await scanLikelyUses(
      root,
      names.map((name, index) =>
        resultWith([{ path: index === 9 ? '$/properties/currency' : '$' }], {
          'capability:search_code': { kind: 'mcp.tool', name },
        }),
      ),
      { maxPerChange: 21 },
    );
    expect(reports.flatMap((report) => report!.changes[0]!.uses)).toHaveLength(
      200,
    );
    expect(reports.at(-1)?.changes[0]?.uses.at(-1)).toEqual({
      term: 'tool_9',
      path: 'calls.ts',
      line: 200,
    });
  });

  it.each([5, 18])(
    'reads only a non-aligned byte budget of %i, including in the last file',
    async (maxBytes) => {
      const root = await tempDir('interfacedelta-uses-byte-boundary-');
      await write(join(root, 'a.ts'), 'x');
      await write(join(root, 'z.ts'), 'search_code();\nsearch_code();\n');
      const actual = await vi.importActual<typeof fs>('node:fs/promises');
      let bytesRead = 0;
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...args) => {
          const result = await read(...args);
          bytesRead += result.bytesRead;
          return result;
        });
        return handle;
      });
      try {
        const [report] = await scanLikelyUses(
          root,
          [toolResult('search_code')],
          {
            maxBytes,
          },
        );
        expect(bytesRead).toBe(maxBytes);
        expect(report?.truncated).toBe(true);
        expect(report?.changes[0]?.uses).toEqual(
          maxBytes === 18
            ? [{ term: 'search_code', path: 'z.ts', line: 1 }]
            : [],
        );
      } finally {
        vi.mocked(fs.open).mockImplementation(actual.open);
      }
    },
  );

  it('does not mark an exact byte fit in the final file as truncated', async () => {
    const root = await tempDir('interfacedelta-uses-byte-exact-');
    const content = 'search_code();\n';
    await write(join(root, 'a.ts'), content);
    const [report] = await scanLikelyUses(root, [toolResult('search_code')], {
      maxBytes: Buffer.byteLength(content),
    });
    expect(report?.truncated).toBe(false);
    expect(report?.changes[0]?.uses).toHaveLength(1);
  });

  it('never includes line text in its results', async () => {
    const root = await tempDir('interfacedelta-uses-secret-');
    await write(
      join(root, 'secret.ts'),
      'const token = "LIVE_SECRET_TEXT"; call search_code();\n',
    );
    const [report] = await scanLikelyUses(root, [toolResult('search_code')]);
    expect(JSON.stringify(report)).not.toContain('LIVE_SECRET_TEXT');
    expect(report?.changes[0]?.uses[0]).toEqual({
      term: 'search_code',
      path: 'secret.ts',
      line: 1,
    });
  });

  it('orders results by path, then line', async () => {
    const root = await tempDir('interfacedelta-uses-order-');
    await write(join(root, 'b', 'm.ts'), 'x\nsearch_code();\n');
    await write(join(root, 'a.ts'), 'x\nsearch_code();\nsearch_code();\n');
    const [report] = await scanLikelyUses(root, [toolResult('search_code')]);
    expect(report?.changes[0]?.uses).toEqual([
      { term: 'search_code', path: 'a.ts', line: 2 },
      { term: 'search_code', path: 'a.ts', line: 3 },
      { term: 'search_code', path: 'b/m.ts', line: 2 },
    ]);
  });

  it('collects only useful terms from blocked and warned changes', async () => {
    const root = await tempDir('interfacedelta-uses-terms-');
    await write(
      join(root, 'terms.ts'),
      ['search_code();', 'status();', 'https://api.example.com/mcp;'].join(
        '\n',
      ),
    );
    const results = [
      resultWith(
        [
          { entityId: 'capability:abc', action: 'block' },
          { entityId: 'endpoint:1', path: 'protocols.status', action: 'warn' },
          { entityId: 'capability:allowed', action: 'allow' },
        ],
        {
          'capability:abc': { kind: 'mcp.tool', name: 'abc' },
          'endpoint:1': {
            kind: 'mcp.endpoint',
            name: 'https://api.example.com/mcp',
          },
          'capability:allowed': { kind: 'mcp.tool', name: 'allowed_tool' },
        },
      ),
      resultWith([]),
    ];
    const reports = await scanLikelyUses(root, results);
    expect(reports[1]).toBeUndefined();
    expect(reports[0]?.changes).toHaveLength(1);
    expect(reports[0]?.changes[0]).toEqual({
      change: 'change:1',
      uses: [{ term: 'status', path: 'terms.ts', line: 2 }],
    });
  });

  it('searches the last path segment of schema changes', async () => {
    const root = await tempDir('interfacedelta-uses-path-');
    await write(join(root, 'schema.ts'), 'input.properties.currency;\n');
    const [report] = await scanLikelyUses(root, [
      resultWith([{ path: '$/properties/currency', action: 'warn' }], {}),
    ]);
    expect(report?.changes[0]?.uses).toEqual([
      { term: 'currency', path: 'schema.ts', line: 1 },
    ]);
  });

  it.each([
    ['$/properties/account~1currency', 'account/currency'],
    ['$/properties/account~0currency', 'account~currency'],
    ['$/properties/account~01currency', 'account~1currency'],
    ['$/properties/account.currency', 'account.currency'],
    ['commerce.account.currency', 'currency'],
  ])('parses the final field token of %s', async (path, term) => {
    const root = await tempDir('interfacedelta-uses-pointer-');
    await write(join(root, 'schema.ts'), `input["${term}"];\nother_field;\n`);
    const [report] = await scanLikelyUses(root, [resultWith([{ path }])]);
    expect(report?.changes[0]?.uses).toEqual([
      { term, path: 'schema.ts', line: 1 },
    ]);
  });

  it('does not search pointer fragments or discard an empty final token', async () => {
    const root = await tempDir('interfacedelta-uses-pointer-fragments-');
    await write(join(root, 'schema.ts'), 'currency;\nproperties;\n');
    const [literal, empty] = await scanLikelyUses(root, [
      resultWith([{ path: '$/properties/account.currency' }]),
      resultWith([{ path: '$/properties/' }]),
    ]);
    expect(literal?.changes[0]?.uses).toEqual([]);
    expect(empty).toBeUndefined();
  });

  it('uses the documented default limits', () => {
    expect(DEFAULT_LIKELY_USES_LIMITS).toEqual({
      maxFiles: 20_000,
      maxBytes: 64 * 1024 * 1024,
      maxPerChange: 20,
      maxTotal: 200,
    });
  });
});

describe('check --find-uses', () => {
  const tool = (name: string) => {
    const passport = passportFixture();
    passport.inventoryGroups.push({
      id: 'inventory:tools',
      kind: 'mcp.tool',
      sourceRef: 'endpoint:test',
      attempted: true,
      complete: true,
      itemCount: 1,
    });
    passport.capabilities.push({
      id: `capability:${name}`,
      kind: 'mcp.tool',
      protocol: 'mcp',
      protocolKey: name,
      name,
      sourceRef: 'endpoint:test',
      metadata: {},
      inventory: { complete: true },
      fingerprint: {
        algorithm: 'sha256',
        canonicalization: 'RFC8785',
        projectionVersion: 'capability-semantic-v4',
        value: 'a'.repeat(64),
      },
      provenance: ['mcp:list'],
    });
    passport.fingerprints.passport.value = computePassportFingerprint(passport);
    return passport;
  };
  const currentWithout = () => {
    const passport = passportFixture();
    passport.inventoryGroups.push({
      id: 'inventory:tools',
      kind: 'mcp.tool',
      sourceRef: 'endpoint:test',
      attempted: true,
      complete: true,
      itemCount: 0,
    });
    passport.fingerprints.passport.value = computePassportFingerprint(passport);
    return passport;
  };

  it('reports likely uses in human and JSON output, and is off by default', async () => {
    const dir = await tempDir('interfacedelta-cli-uses-');
    const baselinePath = join(dir, 'passport.json');
    expect(
      await runCli(
        ['baseline', 'https://example.com', '--output', baselinePath],
        {
          inspector: async () => tool('search_code'),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      ),
    ).toBe(0);
    const repository = await tempDir('interfacedelta-cli-repo-');
    await write(
      join(repository, 'src', 'tools.ts'),
      '// tools\nclient.call("search_code", {});\n',
    );
    const human: string[] = [];
    expect(
      await runCli(
        [
          'check',
          'https://example.com',
          '--baseline',
          baselinePath,
          '--find-uses',
          repository,
        ],
        {
          inspector: async () => currentWithout(),
          stdout: (value) => human.push(value),
          stderr: () => undefined,
        },
      ),
    ).toBe(1);
    const text = human.join('');
    expect(text).toContain('Likely uses');
    expect(text).toContain('src/tools.ts:2 search_code');
    expect(text).not.toContain('client.call');
    const json: string[] = [];
    expect(
      await runCli(
        [
          'check',
          'https://example.com',
          '--baseline',
          baselinePath,
          '--find-uses',
          repository,
          '--json',
        ],
        {
          inspector: async () => currentWithout(),
          stdout: (value) => json.push(value),
          stderr: () => undefined,
        },
      ),
    ).toBe(1);
    const parsed = JSON.parse(json.join(''));
    expect(parsed.formatVersion).toBe('interfacedelta-check-v2');
    expect(parsed.likelyUses.changes[0].uses).toContainEqual({
      term: 'search_code',
      path: 'src/tools.ts',
      line: 2,
    });
    expect(json.join('')).not.toContain('client.call');
    const plain: string[] = [];
    expect(
      await runCli(
        ['check', 'https://example.com', '--baseline', baselinePath, '--json'],
        {
          inspector: async () => currentWithout(),
          stdout: (value) => plain.push(value),
          stderr: () => undefined,
        },
      ),
    ).toBe(1);
    expect(JSON.parse(plain.join('')).likelyUses).toBeUndefined();
    const plainHuman: string[] = [];
    expect(
      await runCli(
        ['check', 'https://example.com', '--baseline', baselinePath],
        {
          inspector: async () => currentWithout(),
          stdout: (value) => plainHuman.push(value),
          stderr: () => undefined,
        },
      ),
    ).toBe(1);
    expect(plainHuman.join('')).not.toContain('Likely uses');
  });

  it('scans for a dependencies check too, and warns instead of failing on a bad directory', async () => {
    const dir = await tempDir('interfacedelta-cli-dep-');
    const baselinePath = join(dir, 'passport.json');
    expect(
      await runCli(
        ['baseline', 'https://example.com', '--output', baselinePath],
        {
          inspector: async () => tool('search_code'),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      ),
    ).toBe(0);
    await write(
      join(dir, 'dependencies.json'),
      JSON.stringify({
        formatVersion: 'interfacedelta-dependencies-v1',
        dependencies: [
          {
            name: 'fixture',
            url: 'https://example.com',
            baseline: 'passport.json',
          },
        ],
      }),
    );
    const repository = await tempDir('interfacedelta-cli-repo2-');
    await write(join(repository, 'app.py'), 'x = 1\nrun("search_code")\n');
    const human: string[] = [];
    expect(
      await runCli(
        [
          'check',
          '--dependencies',
          join(dir, 'dependencies.json'),
          '--find-uses',
          repository,
        ],
        {
          inspector: async () => currentWithout(),
          stdout: (value) => human.push(value),
          stderr: () => undefined,
        },
      ),
    ).toBe(1);
    expect(human.join('')).toContain('app.py:2 search_code');
    const errors: string[] = [];
    expect(
      await runCli(
        [
          'check',
          '--dependencies',
          join(dir, 'dependencies.json'),
          '--find-uses',
          join(dir, 'missing-directory'),
        ],
        {
          inspector: async () => currentWithout(),
          stdout: (value) => human.push(value),
          stderr: (value) => errors.push(value),
        },
      ),
    ).toBe(1);
    expect(errors.join('')).toContain('likely-uses scan skipped');
  });
});
