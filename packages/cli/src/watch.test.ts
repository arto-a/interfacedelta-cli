import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseArguments } from './arguments';
import { runCli } from './run';
import type { WatchEnvironment } from './watch';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const TOKEN = 'idp_v1_watch-test-secret-token';

type Call = { method: string; url: string; headers: Headers; body?: unknown };

let directory = '';
let file = '';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'interfacedelta-watch-'));
  await mkdir(join(directory, '.interfacedelta'));
  file = join(directory, '.interfacedelta', 'dependencies.json');
  await writeFile(
    file,
    JSON.stringify({
      formatVersion: 'interfacedelta-dependencies-v1',
      owner: '@acme/platform',
      dependencies: [
        { name: 'api', url: 'https://api.example.com', baseline: 'api.json' },
      ],
    }),
  );
});

/** A scripted service: each request takes the next response. */
function service(...responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fetchFake = (async (input: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${String(input)}`);
    return next();
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** A clone where `ancestors` lists commits that precede NEW. */
function git(
  options: {
    known?: string[];
    ancestorsOfNew?: string[];
    shallow?: boolean;
    branch?: string | null;
    head?: boolean;
  } = {},
) {
  const known = new Set(options.known ?? [OLD, NEW, OTHER]);
  const ancestors = new Set(options.ancestorsOfNew ?? [OLD]);
  return ((args: string[]) => {
    const [command, ...rest] = args;
    if (command === 'symbolic-ref')
      return options.branch === null
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: options.branch ?? 'main' };
    if (command === 'rev-parse' && rest[0] === '--is-shallow-repository')
      return { status: 0, stdout: options.shallow ? 'true' : 'false' };
    if (command === 'rev-parse' && rest[0] === 'HEAD' && options.head === false)
      return { status: 128, stdout: '' };
    if (command === 'rev-parse' && rest[0] === 'HEAD')
      return { status: 0, stdout: NEW };
    if (command === 'rev-parse') return { status: 0, stdout: 'main' };
    if (command === 'remote')
      return { status: 0, stdout: 'git@github.com:acme/app.git' };
    if (command === 'cat-file')
      return { status: known.has(rest[1]!.slice(0, 40)) ? 0 : 1, stdout: '' };
    if (command === 'merge-base') {
      // A shallow clone lacks the history that joins any two commits.
      if (options.shallow) return { status: 1, stdout: '' };
      const [, base, head] = rest;
      if (head === NEW)
        return { status: ancestors.has(base!) ? 0 : 1, stdout: '' };
      if (
        base === NEW &&
        head === OTHER &&
        options.ancestorsOfNew === undefined
      )
        return { status: 1, stdout: '' };
      return { status: base === NEW ? 0 : 1, stdout: '' };
    }
    return { status: 1, stdout: '' };
  }) as WatchEnvironment['git'];
}

async function run(
  argv: string[],
  watch: Partial<WatchEnvironment>,
): Promise<{ code: number; out: string; err: string }> {
  let out = '',
    err = '';
  const code = await runCli(argv, {
    stdout: (value) => (out += value),
    stderr: (value) => (err += value),
    now: () => new Date('2026-10-28T00:00:00Z'),
    watch: {
      env: { INTERFACEDELTA_API_TOKEN: TOKEN },
      git: git(),
      ...watch,
    },
  });
  return { code, out, err };
}

describe('interfacedelta watch', () => {
  it('creates a watch with If-Match "0" and the file as written', async () => {
    const api = service(
      () => json(404, { status: 'not_found' }),
      () =>
        json(200, {
          status: 'synced',
          syncVersion: '1',
          monitors: 1,
          commitSha: NEW,
        }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Watching 1 dependency for acme/app@main');
    const [read, put] = api.calls;
    expect(read!.url).toBe(
      'https://interfacedelta.com/api/v1/lockfiles/acme%2Fapp?ref=main',
    );
    expect(read!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(put!.method).toBe('PUT');
    expect(put!.headers.get('if-match')).toBe('"0"');
    expect(put!.body).toMatchObject({
      ref: 'main',
      commitSha: NEW,
      force: false,
      document: { formatVersion: 'interfacedelta-dependencies-v1' },
    });
  });

  it('syncs when the watched commit is an ancestor', async () => {
    const api = service(
      () => json(200, { syncVersion: '4', commitSha: OLD }, { etag: '"4"' }),
      () => json(200, { status: 'synced', syncVersion: '5', monitors: 1 }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(result.code).toBe(0);
    expect(api.calls[1]!.headers.get('if-match')).toBe('"4"');
  });

  it('skips an older commit without writing, unless --force', async () => {
    const newer = () =>
      json(200, { syncVersion: '7', commitSha: OTHER }, { etag: '"7"' });
    const skipped = service(newer);
    const result = await run(['watch', '--dependencies', file], {
      fetch: skipped.fetch,
      git: git({ ancestorsOfNew: [] }),
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Skipped: acme/app@main');
    expect(skipped.calls).toHaveLength(1);

    const forced = service(newer, () =>
      json(200, { status: 'synced', syncVersion: '8', monitors: 1 }),
    );
    await run(['watch', '--dependencies', file, '--force'], {
      fetch: forced.fetch,
      git: git({ ancestorsOfNew: [] }),
    });
    expect(forced.calls[1]!.body).toMatchObject({ force: true });
    expect(forced.calls[1]!.headers.get('if-match')).toBe('"7"');
  });

  it('rereads and retries once after a conflict, then stops', async () => {
    const stored = (version: string) => () =>
      json(
        200,
        { syncVersion: version, commitSha: OLD },
        { etag: `"${version}"` },
      );
    const retried = service(
      stored('2'),
      () => json(409, { status: 'conflict' }),
      stored('3'),
      () => json(200, { status: 'synced', syncVersion: '4', monitors: 1 }),
    );
    expect(
      (await run(['watch', '--dependencies', file], { fetch: retried.fetch }))
        .code,
    ).toBe(0);
    expect(retried.calls[3]!.headers.get('if-match')).toBe('"3"');

    const conflicted = service(
      stored('2'),
      () => json(409, { status: 'conflict' }),
      stored('3'),
      () => json(409, { status: 'conflict' }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: conflicted.fetch,
    });
    expect(result.code).toBe(3);
    expect(result.err).toContain('changed it twice');
  });

  it('names plan limits and refuses nothing silently', async () => {
    const api = service(
      () => json(404, {}),
      () => json(422, { status: 'monitor_limit', count: 30, limit: 25 }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain('needs 30 monitors; your plan allows 25');
  });

  it("passes on the service's reason for rejecting the file", async () => {
    const api = service(
      () => json(404, {}),
      () =>
        json(400, {
          error: {
            code: 'DUPLICATE_DEPENDENCY',
            message: 'Duplicate dependency name: api',
          },
        }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain(
      'rejected the dependencies file. Duplicate dependency name: api',
    );
  });

  it('never prints the API token', async () => {
    const api = service(() =>
      json(401, { message: `token ${TOKEN} is revoked` }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(result.code).toBe(2);
    expect(result.out + result.err).not.toContain(TOKEN);
    expect(result.err).toContain('refused the API token');
  });

  it('checks ordering through GitHub compare in a shallow checkout', async () => {
    const api = service(
      () => json(200, { syncVersion: '1', commitSha: OLD }, { etag: '"1"' }),
      () => json(200, { status: 'ahead' }),
      () => json(200, { status: 'synced', syncVersion: '2', monitors: 1 }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
      git: git({ known: [NEW] }),
      env: {
        INTERFACEDELTA_API_TOKEN: TOKEN,
        GITHUB_TOKEN: 'ghs_job-token',
        GITHUB_REPOSITORY: 'acme/app',
        GITHUB_SHA: NEW,
        GITHUB_REF_TYPE: 'branch',
        GITHUB_REF_NAME: 'main',
      },
    });
    expect(result.code).toBe(0);
    expect(api.calls[1]!.url).toBe(
      `https://api.github.com/repos/acme/app/compare/${OLD}...${NEW}`,
    );
  });

  it('asks for history when ordering cannot be proven', async () => {
    const api = service(() =>
      json(200, { syncVersion: '1', commitSha: OLD }, { etag: '"1"' }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
      git: git({ known: [NEW] }),
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain('fetch-depth: 0');
  });

  it('stops watching with the current version', async () => {
    const api = service(
      () => json(200, { syncVersion: '9', commitSha: OLD }, { etag: '"9"' }),
      () => new Response(null, { status: 204 }),
    );
    const result = await run(['watch', '--off'], { fetch: api.fetch });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Stopped watching acme/app@main');
    expect(api.calls[1]!.method).toBe('DELETE');
    expect(api.calls[1]!.headers.get('if-match')).toBe('"9"');
  });

  it('validates the file locally before any request', async () => {
    await writeFile(file, JSON.stringify({ formatVersion: 'nope' }));
    const api = service(() => json(404, {}));
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain('Dependencies file is invalid');
  });

  it('requires a token and an https API origin', async () => {
    const api = service();
    expect(
      (
        await run(['watch', '--dependencies', file], {
          fetch: api.fetch,
          env: {},
        })
      ).err,
    ).toContain('INTERFACEDELTA_API_TOKEN');
    expect(
      (
        await run(['watch', '--dependencies', file], {
          fetch: api.fetch,
          env: {
            INTERFACEDELTA_API_TOKEN: TOKEN,
            INTERFACEDELTA_API_URL: 'http://interfacedelta.com',
          },
        })
      ).err,
    ).toContain('https://');
    expect(api.calls).toHaveLength(0);
  });
});

describe('watch review fixes', () => {
  it('never sends GITHUB_TOKEN to a non-https GitHub API', async () => {
    const api = service(() =>
      json(200, { syncVersion: '1', commitSha: OLD }, { etag: '"1"' }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
      git: git({ known: [NEW] }),
      env: {
        INTERFACEDELTA_API_TOKEN: TOKEN,
        GITHUB_TOKEN: 'ghs_job-token',
        GITHUB_API_URL: 'http://github.example',
      },
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain('GITHUB_API_URL must be an https://');
    expect(api.calls).toHaveLength(1);
  });

  it('requires --ref on a tag or detached checkout', async () => {
    const api = service();
    const tag = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
      env: {
        INTERFACEDELTA_API_TOKEN: TOKEN,
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'acme/app',
        GITHUB_SHA: NEW,
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: 'v1.0.0',
      },
    });
    expect(tag.code).toBe(2);
    expect(tag.err).toContain('pass --ref');
    const detached = await run(['watch', '--off'], {
      fetch: api.fetch,
      git: git({ branch: null }),
    });
    expect(detached.err).toContain('pass --ref');
    expect(api.calls).toHaveLength(0);
  });

  it('treats missing shallow history as unknown and asks GitHub', async () => {
    const api = service(
      () => json(200, { syncVersion: '1', commitSha: OTHER }, { etag: '"1"' }),
      () => json(200, { status: 'ahead' }),
      () => json(200, { status: 'synced', syncVersion: '2', monitors: 1 }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
      git: git({ ancestorsOfNew: [], shallow: true }),
      env: { INTERFACEDELTA_API_TOKEN: TOKEN, GITHUB_TOKEN: 'ghs_job-token' },
    });
    expect(result.code).toBe(0);
    expect(api.calls[1]!.url).toContain(`/compare/${OTHER}...${NEW}`);
  });

  it('unwatches outside a clone with --repository and --ref', async () => {
    const api = service(
      () => json(200, { syncVersion: '3' }, { etag: '"3"' }),
      () => new Response(null, { status: 204 }),
    );
    const result = await run(
      ['watch', '--off', '--repository', 'acme/app', '--ref', 'main'],
      { fetch: api.fetch, git: git({ head: false, branch: null }) },
    );
    expect(result.code).toBe(0);
    expect(api.calls[1]!.method).toBe('DELETE');
  });

  it('rejects refs the service would refuse', async () => {
    const api = service();
    for (const ref of ['bad..ref', 'has space', 'a@{b', 'x'.repeat(256)]) {
      const result = await run(
        ['watch', '--dependencies', file, '--ref', ref],
        { fetch: api.fetch },
      );
      expect(result.code).toBe(2);
      expect(result.err).toContain('Not a valid ref');
    }
    expect(api.calls).toHaveLength(0);
  });
});

describe('watch arguments', () => {
  it('accepts its own options only', () => {
    expect(
      parseArguments(['watch', '--repository', 'acme/app', '--ref', 'main']),
    ).toMatchObject({
      command: 'watch',
      repository: 'acme/app',
      ref: 'main',
      dependencies: '.interfacedelta/dependencies.json',
    });
    expect(() => parseArguments(['watch', 'https://example.com'])).toThrow(
      'watch takes no target URL',
    );
    expect(() => parseArguments(['watch', '--token', 'x=Y'])).toThrow(
      '--token is not valid with watch.',
    );
    expect(() => parseArguments(['watch', '--off', '--force'])).toThrow(
      '--force is not valid with --off.',
    );
    expect(() => parseArguments(['check', '--repository', 'acme/app'])).toThrow(
      '--repository is only valid with watch.',
    );
    expect(() => parseArguments(['check', '--off'])).toThrow(
      '--off is only valid with watch.',
    );
    for (const flag of [
      ['--off'],
      ['--repository', 'acme/app'],
      ['--ref', 'main'],
    ])
      expect(() =>
        parseArguments([
          'accept',
          'api',
          'change:aaaaaaaaaaaaaaaaaaaaaaaa',
          '--reason',
          'r',
          '--days',
          '1',
          ...flag,
        ]),
      ).toThrow(`${flag[0]} is not valid with accept.`);
  });
});

describe('watch sync version', () => {
  it('uses a strong ETag as the sync version', async () => {
    const api = service(
      () => json(200, { syncVersion: '4', commitSha: OLD }, { etag: '"4"' }),
      () => json(200, { status: 'synced', syncVersion: '5', monitors: 1 }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(result.code).toBe(0);
    expect(api.calls[1]!.headers.get('if-match')).toBe('"4"');
  });

  it('unwraps a weak ETag into a quoted strong If-Match', async () => {
    const api = service(
      () => json(200, { commitSha: OLD }, { etag: 'W/"6"' }),
      () => json(200, { status: 'synced', syncVersion: '7', monitors: 1 }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(result.code).toBe(0);
    expect(api.calls[1]!.headers.get('if-match')).toBe('"6"');
  });

  it('prefers the body syncVersion over the ETag header', async () => {
    const api = service(
      () => json(200, { syncVersion: 12, commitSha: OLD }, { etag: 'W/"11"' }),
      () => json(200, { status: 'synced', syncVersion: '13', monitors: 1 }),
    );
    const result = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(result.code).toBe(0);
    expect(api.calls[1]!.headers.get('if-match')).toBe('"12"');
  });

  it('rejects an ETag it cannot parse instead of sending it', async () => {
    for (const etag of [
      '1',
      '"abc"',
      'W/1',
      'W/"1',
      '"01"',
      'W/"9007199254740992"',
    ]) {
      const api = service(() => json(200, { commitSha: OLD }, { etag }));
      const result = await run(['watch', '--dependencies', file], {
        fetch: api.fetch,
      });
      expect(result.code).toBe(3);
      expect(result.err).toContain('no usable sync version');
      expect(api.calls).toHaveLength(1);
    }
  });

  it('ignores a non-canonical body version and falls back to the ETag', async () => {
    for (const syncVersion of ['01', -1, 1.5, 2 ** 53]) {
      const api = service(
        () => json(200, { syncVersion, commitSha: OLD }, { etag: 'W/"1"' }),
        () => json(200, { status: 'synced', syncVersion: 2, monitors: 1 }),
      );
      const result = await run(['watch', '--dependencies', file], {
        fetch: api.fetch,
      });
      expect(result.code).toBe(0);
      expect(api.calls[1]!.headers.get('if-match')).toBe('"1"');
    }
  });

  it('sends a quoted version on the next sync after a weakened ETag', async () => {
    const api = service(
      () => json(404, { status: 'not_found' }),
      () => json(200, { status: 'synced', syncVersion: '1', monitors: 1 }),
      () => json(200, { commitSha: NEW }, { etag: 'W/"1"' }),
      () => json(200, { status: 'synced', syncVersion: '2', monitors: 1 }),
    );
    const first = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    const second = await run(['watch', '--dependencies', file], {
      fetch: api.fetch,
    });
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(api.calls[2]!.headers.get('if-match')).toBeNull();
    expect(api.calls[3]!.headers.get('if-match')).toBe('"1"');
  });
});
