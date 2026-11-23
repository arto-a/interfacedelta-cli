import './test-network-block.cjs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArguments } from './arguments';
import { runCite } from './cite';
import {
  formatCitation,
  insertCitation,
  parseCitations,
  type Citation,
  type SourceCitation,
} from './citation-format';
import {
  citationsFailOn,
  citationsToSarif,
  formatCitations,
  runCitations,
  type CitationsReport,
} from './citations';
import {
  citationFixture,
  citationLine,
  citationGoal,
  signedCitationAnswer,
} from './citations-fixture';
import {
  citationCheckoutRoot,
  fetchCitationSource,
  hashCitationFile,
  parseGitSource,
  SOURCE_MAX_BYTES,
  SOURCE_TIMEOUT_MS,
} from './citation-source';
import { runCli } from './run';
import { skillFile } from './skills-fixture';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'citation-source-'));
  roots.push(root);
  return root;
}
const digest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const hash = digest('source bytes');
const fileCitation: SourceCitation = {
  kind: 'file',
  path: 'docs/source.bin',
  sha256: hash,
};
const urlCitation: SourceCitation = {
  kind: 'url',
  uri: 'https://sources.example/paper?version=2',
  sha256: hash,
};
const gitCitation: SourceCitation = {
  kind: 'git',
  repo: 'https://code.example/project.git',
  commit: 'a'.repeat(40),
  path: 'docs/paper.md',
};
const sources = [fileCitation, urlCitation, gitCitation];
const networkEnvironment = (fetcher: typeof fetch) => ({
  fetch: fetcher,
  citationNetwork: {
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    request: vi.fn(async (url: URL, _address: unknown, init: RequestInit) =>
      fetcher(url.href, {
        ...init,
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
      }),
    ),
  },
});
const environment = (
  body: BodyInit | null = 'source bytes',
  init?: ResponseInit,
) => {
  const fetcher = vi.fn(async () => new Response(body, init));
  return { env: {}, ...networkEnvironment(fetcher), fetch: fetcher };
};

describe('source citation v1 parser', () => {
  it.each<Citation>([
    ...sources,
    { ...gitCitation, path: undefined, commit: 'b'.repeat(64) },
    { ...citationFixture, kind: 'mcp-tool' },
    { ...citationFixture, checked: undefined, label: "Author's tool" },
    { ...fileCitation, checked: '2024-02-29', label: 'x'.repeat(120) },
    { ...urlCitation, sha256: hash.toUpperCase(), label: '<Paper "v2"' },
  ])('accepts and round-trips %j', (citation) => {
    const line = formatCitation(citation);
    expect(parseCitations(line)[0]!.citation).toEqual(
      Object.fromEntries(
        Object.entries(citation).filter(([, value]) => value !== undefined),
      ),
    );
  });
  const lines = [
    ...sources,
    citationFixture,
    { ...citationFixture, kind: 'mcp-tool' } as const,
  ].map(formatCitation);
  it.each([
    ...lines
      .filter((line) => line.includes('kind='))
      .map((line) => line.replace('kind=', 'Kind=')),
    ...lines.map((line) => line.replace(' -->', ' extra="bad" -->')),
    ...lines.map((line) => line.replace(' -->', ' checked="2026-02-30" -->')),
    ...lines.map((line) =>
      line.replace(' -->', ` label="${'x'.repeat(121)}" -->`),
    ),
    ...lines.map((line) => line.replace(' -->', ' label="bad--label" -->')),
    ...lines.map((line) => line.replace(' -->', ' label="bad>label" -->')),
    ...lines.map((line) => line.replace(' -->', ' label="a" label="b" -->')),
    ...[
      '../outside',
      '/absolute',
      'a/../outside',
      'a/./b',
      'a//b',
      'C:/x',
      'a\\b',
      '',
    ].map((path) => lines[0]!.replace('docs/source.bin', path)),
    ...[
      'http://sources.example/paper',
      'https://user:pass@sources.example/paper',
      'https://@sources.example/paper',
      'https://sources.example/with space',
    ].map((uri) => lines[1]!.replace(urlCitation.uri, uri)),
    ...['http://code.example/repo', 'https://user:pass@code.example/repo'].map(
      (repo) => lines[2]!.replace(gitCitation.repo, repo),
    ),
    lines[0]!.replace('kind="file" ', ''),
    lines[0]!.replace('kind="file"', 'kind="paper"'),
    lines[0]!.replace(`sha256="${hash}"`, 'sha256="bad"'),
    lines[0]!.replace('path="docs/source.bin"', 'path=docs/source.bin'),
    lines[0]!.replace(' -->', ' fingerprint="sha256:bad" -->'),
    lines[1]!.replace(' -->', ' path="docs/x" -->'),
    lines[2]!.replace('a'.repeat(40), 'a'.repeat(39)),
    lines[2]!.replace('a'.repeat(40), 'g'.repeat(40)),
    lines[2]!.replace('docs/paper.md', '../outside'),
    ...lines.map((line) => line.replace(' -->', '')),
  ])('reports malformed without citation text: %s', (line) => {
    expect(parseCitations(line)).toEqual([
      { start: 0, end: line.length, line: 1, error: 'Malformed citation v1.' },
    ]);
  });
  it.each(sources)(
    'updates only the same source idempotently: $kind',
    (citation) => {
      const content = '\uFEFF# Private instructions\r\n';
      const inserted = insertCitation(content, citation);
      expect(insertCitation(inserted, citation)).toBe(inserted);
      const updated: SourceCitation =
        citation.kind === 'git'
          ? { ...citation, commit: 'c'.repeat(64) }
          : { ...citation, sha256: 'd'.repeat(64) };
      const next = insertCitation(inserted + citationLine, updated);
      expect(parseCitations(next).map((entry) => entry.citation)).toEqual([
        updated,
        citationFixture,
      ]);
      expect(next).toContain('# Private instructions\r\n');
    },
  );
  it.each([
    `${gitCitation.repo}@${gitCitation.commit}`,
    `${gitCitation.repo}@${'b'.repeat(64)}:docs/x.md`,
    `https://code.example:8443/repo@${gitCitation.commit}:docs/x.md`,
  ])('parses full Git pins: %s', (value) => {
    expect(parseGitSource(value)).toMatchObject({ kind: 'git' });
  });
  it.each([
    `http://code.example/repo@${gitCitation.commit}`,
    `https://user:pass@code.example/repo@${gitCitation.commit}`,
    `${gitCitation.repo}@main`,
    `${gitCitation.repo}@${gitCitation.commit}:../x`,
    `${gitCitation.repo}@${gitCitation.commit}:`,
    `${gitCitation.repo}@${'b'.repeat(41)}`,
  ])('rejects invalid Git argument: %s', (value) =>
    expect(() => parseGitSource(value)).toThrow(),
  );
});

describe('file source checks', () => {
  it('caps file hashing at 10 MiB and reports too_large through both commands', async () => {
    const root = await workspace();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    await skillFile(root, 'SKILL.md', formatCitation(fileCitation));
    await skillFile(root, fileCitation.path, '');
    await fs.truncate(join(root, fileCitation.path), SOURCE_MAX_BYTES);
    expect((await hashCitationFile(root, fileCitation.path)).status).toBe(
      'current',
    );
    await fs.truncate(join(root, fileCitation.path), SOURCE_MAX_BYTES + 1);
    expect(await hashCitationFile(root, fileCitation.path)).toEqual({
      status: 'unreachable',
      reason: 'too_large',
    });
    const result = await runCitations(
      { dir: root, failOn: 'unreachable' },
      environment(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.report.citations[0]).toMatchObject({
      status: 'unreachable',
      reason: 'too_large',
    });
    expect(result.output).toContain('unreachable (too_large)');
    expect(JSON.stringify(citationsToSarif(result.report))).toContain(
      'too_large',
    );
    await expect(
      runCite({ fileSource: fileCitation.path }, environment()),
    ).rejects.toThrow('unreachable (too_large)');
  });
  it('falls back to the scan root when an ancestor cannot be read', async () => {
    const root = await workspace();
    await skillFile(root, 'nested/SKILL.md', formatCitation(fileCitation));
    await skillFile(root, 'nested/' + fileCitation.path, 'source bytes');
    const original = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation(
      (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === join(root, '.git'))
          return Promise.reject(
            Object.assign(new Error('unreadable'), { code: 'EACCES' }),
          );
        return original(...args);
      },
    );
    const scanRoot = join(root, 'nested');
    expect(await citationCheckoutRoot(scanRoot)).toBe(scanRoot);
    expect(
      (await runCitations({ dir: scanRoot }, environment())).report
        .citations[0]!.status,
    ).toBe('current');
  });

  it('hashes exact binary bytes and reports current, changed and missing offline', async () => {
    const root = await workspace();
    const bytes = Buffer.from([0, 255, 13, 10, 195, 169]);
    await skillFile(root, 'docs/source.bin', '');
    await writeFile(join(root, fileCitation.path), bytes);
    await skillFile(
      root,
      'SKILL.md',
      'Private instructions\n' +
        formatCitation({
          ...fileCitation,
          sha256: digest(bytes).toUpperCase(),
        }),
    );
    const env = environment();
    const check = () =>
      runCitations({ dir: root, json: true, failOn: 'changed,missing' }, env);
    expect((await check()).report.citations[0]).toMatchObject({
      status: 'current',
      currentSha256: digest(bytes),
    });
    await writeFile(join(root, fileCitation.path), Buffer.from([0, 255]));
    expect((await check()).exitCode).toBe(1);
    expect((await check()).report.citations[0]!.status).toBe('changed');
    await rm(join(root, fileCitation.path));
    const missing = await check();
    expect(missing.report.citations[0]!.status).toBe('missing');
    expect(missing.exitCode).toBe(1);
    expect(missing.output).not.toContain('Private instructions');
    expect(env.fetch).not.toHaveBeenCalled();
  });
  it.each(['file', 'directory'])('refuses %s symlink escapes', async (kind) => {
    const root = await workspace(),
      outside = await workspace();
    await skillFile(outside, 'source.bin', 'source bytes');
    if (kind === 'directory') await symlink(outside, join(root, 'docs'));
    else {
      await mkdir(join(root, 'docs'));
      await symlink(join(outside, 'source.bin'), join(root, 'docs/source.bin'));
    }
    await skillFile(root, 'SKILL.md', formatCitation(fileCitation));
    expect(
      (await runCitations({ dir: root }, environment())).report.citations[0]!
        .status,
    ).toBe('malformed');
  });
  it.each(['project', 'deep/checkout/project'])(
    'uses checkout-relative sources and scan-relative SARIF at %s',
    async (depth) => {
      const root = await workspace();
      const checkout = join(root, depth);
      await skillFile(checkout, '.git', 'gitdir: fixture');
      await skillFile(checkout, fileCitation.path, 'changed');
      await skillFile(checkout, 'rules/SKILL.md', formatCitation(fileCitation));
      const result = await runCitations(
        { dir: join(checkout, 'rules') },
        environment(),
      );
      expect(result.report.citations[0]!.status).toBe('changed');
      expect(
        citationsToSarif(result.report).runs[0]!.results[0]!.locations[0]!
          .physicalLocation.artifactLocation.uri,
      ).toBe('SKILL.md');
    },
  );
});

describe('public source address guard', () => {
  const blocked = [
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '127.0.0.1',
    '127.255.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '224.0.0.1',
    '239.255.255.255',
    '[::]',
    '[::1]',
    '[fc00::1]',
    '[fdff::1]',
    '[fe80::1]',
    '[febf::1]',
    '[ff02::1]',
    ...[
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '224.0.0.1',
    ].map((ip) => `[::ffff:${ip}]`),
    '[::ffff:7f00:1]',
    '[::ffff:a00:1]',
    'metadata.google.internal',
    'metadata.google.internal.',
    'METADATA.GOOG',
    'metadata.azure.internal',
    'metadata.tencentyun.com',
    'instance-data.ec2.internal',
    'localhost',
  ];
  it.each(blocked)(
    'never requests an initial or redirected non-public host: %s',
    async (host) => {
      const uri = `https://${host}/source`;
      const env = environment();
      expect(await fetchCitationSource(uri, env)).toMatchObject({
        status: 'unreachable',
        reason: expect.stringMatching(/^blocked_/),
      });
      expect(env.citationNetwork.lookup).not.toHaveBeenCalled();
      expect(env.fetch).not.toHaveBeenCalled();
      const redirectEnv = environment(null, {
        status: 302,
        headers: { location: uri },
      });
      expect(
        await fetchCitationSource(urlCitation.uri, redirectEnv),
      ).toMatchObject({
        status: 'unreachable',
        reason: expect.stringMatching(/^blocked_/),
      });
      expect(redirectEnv.fetch).toHaveBeenCalledTimes(1);
      expect(redirectEnv.citationNetwork.lookup).toHaveBeenCalledTimes(1);
    },
  );
  it('checks all DNS answers, including mixed families and private mapped addresses', async () => {
    for (const addresses of [
      [{ address: '10.0.0.1', family: 4 }],
      [
        { address: '93.184.216.34', family: 4 },
        { address: 'fc00::1', family: 6 },
      ],
      [{ address: '::ffff:169.254.169.254', family: 6 }],
    ]) {
      const env = environment();
      env.citationNetwork.lookup.mockResolvedValue(addresses);
      expect(await fetchCitationSource(urlCitation.uri, env)).toEqual({
        status: 'unreachable',
        reason: 'blocked_non_public_address',
      });
      expect(env.fetch).not.toHaveBeenCalled();
    }
  });
  it('resolves each hop again and pins the selected public address into the request', async () => {
    const env = environment(null, {
      status: 302,
      headers: { location: '/same-host' },
    });
    env.citationNetwork.lookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    expect(await fetchCitationSource(urlCitation.uri, env)).toEqual({
      status: 'unreachable',
      reason: 'blocked_non_public_address',
    });
    expect(env.citationNetwork.lookup).toHaveBeenCalledTimes(2);
    expect(env.citationNetwork.request).toHaveBeenCalledTimes(1);
    expect(env.citationNetwork.request.mock.calls[0]![1]).toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });
  it('includes DNS in the deadline and never requests after a late resolution', async () => {
    vi.useFakeTimers();
    const env = environment();
    let finish!: (addresses: { address: string; family: number }[]) => void;
    env.citationNetwork.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = fetchCitationSource(urlCitation.uri, env);
    await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS);
    expect(await pending).toEqual({ status: 'unreachable' });
    finish([{ address: '93.184.216.34', family: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.citationNetwork.request).not.toHaveBeenCalled();
  });
  it('fails closed on absent or failed DNS answers without making a request', async () => {
    for (const fails of [false, true]) {
      const env = environment();
      if (fails)
        env.citationNetwork.lookup.mockRejectedValue(
          new Error('private resolver message'),
        );
      else env.citationNetwork.lookup.mockResolvedValue([]);
      expect(await fetchCitationSource(urlCitation.uri, env)).toEqual({
        status: 'unreachable',
        reason: 'dns_failed',
      });
      expect(env.fetch).not.toHaveBeenCalled();
    }
  });
  it('accepts public IPv4, IPv6 and mapped IPv4', async () => {
    for (const host of [
      '93.184.216.34',
      '100.63.255.255',
      '100.128.0.1',
      '172.32.0.1',
      '[2606:4700:4700::1111]',
      '[::ffff:93.184.216.34]',
    ]) {
      const env = environment();
      expect(
        (await fetchCitationSource(`https://${host}/source`, env)).status,
      ).toBe('current');
      expect(env.citationNetwork.lookup).not.toHaveBeenCalled();
    }
  });
  it('uses the same guard and clear reasons in cite --url and citations --fetch', async () => {
    const root = await workspace();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const uri = 'https://127.0.0.1/private';
    const file = join(root, 'SKILL.md');
    await skillFile(root, 'SKILL.md', formatCitation({ ...urlCitation, uri }));
    const original = await readFile(file, 'utf8');
    const env = environment();
    const result = await runCitations(
      { dir: root, fetch: true, failOn: 'unreachable' },
      env,
    );
    expect(result.exitCode).toBe(1);
    expect(result.report.citations[0]).toMatchObject({
      status: 'unreachable',
      reason: 'blocked_non_public_address',
    });
    expect(result.output).toContain('unreachable (blocked_non_public_address)');
    await expect(runCite({ url: uri, file }, env)).rejects.toThrow(
      'unreachable (blocked_non_public_address)',
    );
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(env.fetch).not.toHaveBeenCalled();
  });
});

describe('bounded URL checks with injected fetch; no internet', () => {
  it.each([
    ['current', 'source bytes', 200],
    ['changed', 'new bytes', 200],
    ['missing', 'private error', 404],
    ['missing', 'private error', 410],
    ['unreachable', 'private error', 503],
  ] as const)('reports %s for HTTP %s / %s', async (status, body, code) => {
    const root = await workspace();
    await skillFile(
      root,
      'SKILL.md',
      'Private instructions\n' + formatCitation(urlCitation),
    );
    const env = environment(body, { status: code });
    const unchecked = await runCitations({ dir: root, json: true }, env);
    expect(unchecked.report.citations[0]!.status).toBe('not_checked');
    expect(env.fetch).not.toHaveBeenCalled();
    const result = await runCitations(
      {
        dir: root,
        fetch: true,
        json: true,
        failOn: 'changed,missing,unreachable',
      },
      env,
    );
    expect(result.report.citations[0]!.status).toBe(status);
    expect(result.exitCode).toBe(status === 'current' ? 0 : 1);
    expect(result.output).not.toContain(
      body === 'source bytes' ? 'source bytes' : 'private error',
    );
    expect(result.output).not.toContain('Private instructions');
    expect(env.fetch).toHaveBeenCalledTimes(1);
    expect(env.fetch.mock.calls[0]).toEqual([
      urlCitation.uri,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        headers: expect.objectContaining({
          'User-Agent': expect.stringMatching(/^interfacedelta-cli\//),
        }),
      }),
    ]);
  });
  it('hashes exact non-text response bytes', async () => {
    const bytes = new Uint8Array([0, 255, 13, 10]);
    expect(
      await fetchCitationSource(urlCitation.uri, environment(bytes)),
    ).toEqual({ status: 'current', sha256: digest(bytes) });
  });
  it('handles an empty body', async () => {
    expect(
      await fetchCitationSource(
        urlCitation.uri,
        environment(null, { status: 204 }),
      ),
    ).toEqual({ status: 'current', sha256: digest('') });
  });
  it.each(['http://unsafe.example/x', 'https://user:pass@unsafe.example/x'])(
    'refuses redirect to %s',
    async (location) => {
      const env = environment(null, { status: 302, headers: { location } });
      expect(await fetchCitationSource(urlCitation.uri, env)).toEqual({
        status: 'unreachable',
      });
      expect(env.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('accepts three HTTPS redirects and rejects a fourth or a redirect without location', async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: '/one' } }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'https://other.example/two' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 308, headers: { location: '/three' } }),
      )
      .mockResolvedValueOnce(new Response('source bytes'));
    expect(
      await fetchCitationSource(urlCitation.uri, networkEnvironment(fetcher)),
    ).toEqual({ status: 'current', sha256: hash });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      urlCitation.uri,
      'https://sources.example/one',
      'https://other.example/two',
      'https://other.example/three',
    ]);
    fetcher
      .mockReset()
      .mockImplementation(
        async () =>
          new Response(null, { status: 302, headers: { location: '/loop' } }),
      );
    expect(
      (await fetchCitationSource(urlCitation.uri, networkEnvironment(fetcher)))
        .status,
    ).toBe('unreachable');
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(
      (
        await fetchCitationSource(
          urlCitation.uri,
          environment(null, { status: 302 }),
        )
      ).status,
    ).toBe('unreachable');
  });
  it('cancels bodies over 10 MiB, including streams without content-length', async () => {
    for (const headers of [
      new Headers(),
      new Headers({ 'content-length': String(SOURCE_MAX_BYTES + 1) }),
    ]) {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(SOURCE_MAX_BYTES + 1));
        },
        cancel,
      });
      expect(
        (
          await fetchCitationSource(
            urlCitation.uri,
            environment(stream, { headers }),
          )
        ).status,
      ).toBe('unreachable');
      expect(cancel).toHaveBeenCalledTimes(1);
    }
    const bytes = new Uint8Array(SOURCE_MAX_BYTES);
    expect(
      (await fetchCitationSource(urlCitation.uri, environment(bytes))).status,
    ).toBe('current');
  });
  it('rejects encoded bytes rather than silently hashing decompressed content', async () => {
    expect(
      (
        await fetchCitationSource(
          urlCitation.uri,
          environment('source bytes', {
            headers: { 'content-encoding': 'gzip' },
          }),
        )
      ).status,
    ).toBe('unreachable');
  });
  it.each(['headers', 'body', 'redirect chain'])(
    'enforces a total 15 s timeout during %s',
    async (stage) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel });
      const fetcher = vi.fn<typeof fetch>(async () =>
        stage === 'headers'
          ? new Promise<Response>(() => {})
          : stage === 'body'
            ? new Response(stream)
            : new Promise<Response>((resolve) =>
                setTimeout(
                  () =>
                    resolve(
                      new Response(null, {
                        status: 302,
                        headers: { location: '/next' },
                      }),
                    ),
                  6000,
                ),
              ),
      );
      const pending = fetchCitationSource(
        urlCitation.uri,
        networkEnvironment(fetcher),
      );
      await vi.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS);
      expect(await pending).toEqual({ status: 'unreachable' });
      expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(
        true,
      );
      if (stage === 'body') expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
  it('reports network/stream errors without leaking their messages or contents', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('PRIVATE network text');
    });
    expect(
      await fetchCitationSource(urlCitation.uri, networkEnvironment(fetcher)),
    ).toEqual({ status: 'unreachable' });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('PRIVATE response'));
      },
    });
    expect(
      await fetchCitationSource(urlCitation.uri, environment(stream)),
    ).toEqual({ status: 'unreachable' });
  });
  it('never exceeds four concurrent source GETs', async () => {
    const root = await workspace();
    await skillFile(
      root,
      'SKILL.md',
      Array.from({ length: 9 }, (_, index) =>
        formatCitation({
          ...urlCitation,
          uri: `https://source.example/${index}`,
        }),
      ).join('\n'),
    );
    let active = 0,
      maximum = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      active++;
      maximum = Math.max(maximum, active);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              active--;
              controller.enqueue(new TextEncoder().encode('source bytes'));
              controller.close();
            }, 5);
          },
        }),
      );
    });
    const result = await runCitations(
      { dir: root, fetch: true },
      { env: {}, ...networkEnvironment(fetcher) },
    );
    expect(
      result.report.citations.every((item) => item.status === 'current'),
    ).toBe(true);
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(9);
  });
});

describe('mixed sources through the CLI', () => {
  it('checks tool records alongside files and URL/Git pins without source requests by default', async () => {
    const root = await workspace();
    await skillFile(root, fileCitation.path, 'source bytes');
    await skillFile(
      root,
      'SKILL.md',
      [citationLine, ...sources.map(formatCitation)].join('\n'),
    );
    const fetcher = vi.fn<typeof fetch>(async (uri) => {
      expect(String(uri)).toBe(
        'https://interfacedelta.com/api/v1/record/check/goal',
      );
      return new Response(
        JSON.stringify(citationGoal([signedCitationAnswer()])),
      );
    });
    const result = await runCitations(
      { dir: root },
      {
        env: { INTERFACEDELTA_AGENT_KEY: 'fixture-citation-source-key' },
        fetch: fetcher,
      },
    );
    expect(result.report.citations.map((item) => item.status)).toEqual([
      'current',
      'current',
      'not_checked',
      'not_checked',
    ]);
    expect(result.report.toolsChecked).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('wires --fetch, thresholds, JSON and SARIF end to end', async () => {
    const root = await workspace();
    await skillFile(
      root,
      'SKILL.md',
      'PRIVATE instruction text\n' + formatCitation(urlCitation),
    );
    const stdout = vi.fn(),
      stderr = vi.fn(),
      env = environment('different source bytes');
    const sarif = join(root, 'out.sarif');
    expect(
      await runCli(
        [
          'citations',
          root,
          '--json',
          '--sarif',
          sarif,
          '--fetch',
          '--fail-on',
          'changed',
        ],
        { stdout, stderr, status: env },
      ),
    ).toBe(1);
    expect(JSON.parse(stdout.mock.calls[0]![0]).citations[0]).toMatchObject({
      status: 'changed',
      currentSha256: digest('different source bytes'),
    });
    expect(stderr).not.toHaveBeenCalled();
    expect(env.fetch).toHaveBeenCalledTimes(1);
    const raw = await readFile(sarif, 'utf8');
    expect(raw).not.toContain('PRIVATE');
    expect(raw).not.toContain('different source bytes');
    expect(
      JSON.parse(raw).runs[0].results[0].locations[0].physicalLocation
        .artifactLocation.uri,
    ).toBe('SKILL.md');
  });
});

describe('source cite commands', () => {
  it.each(sources)(
    'writes $kind idempotently and preserves unrelated citations and CRLF',
    async (source) => {
      const root = await workspace();
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      await skillFile(root, fileCitation.path, 'source bytes');
      const file = join(root, 'rules/SKILL.md');
      const original =
        '\uFEFF# Private instructions\r\n' + citationLine + '\r\n';
      await skillFile(root, 'rules/SKILL.md', original);
      const option =
        source.kind === 'file'
          ? ['--file-source', source.path]
          : source.kind === 'url'
            ? ['--url', source.uri]
            : ['--git', `${source.repo}@${source.commit}:${source.path}`];
      const stdout = vi.fn(),
        stderr = vi.fn(),
        env = environment();
      const run = () =>
        runCli(['cite', ...option, '--file', file], {
          stdout,
          stderr,
          status: env,
          now: () => new Date('2026-11-22T12:00:00Z'),
        });
      expect(await run()).toBe(0);
      const first = await readFile(file, 'utf8');
      expect(await run()).toBe(0);
      expect(stderr).not.toHaveBeenCalled();
      expect(await readFile(file, 'utf8')).toBe(first);
      expect(first).toBe(
        '\uFEFF' +
          formatCitation({ ...source, checked: '2026-11-22' }) +
          '\r\n' +
          original.slice(1),
      );
      expect(env.fetch).toHaveBeenCalledTimes(source.kind === 'url' ? 2 : 0);
      expect(stdout.mock.calls[0]![0]).toBe(
        formatCitation({ ...source, checked: '2026-11-22' }) + '\n',
      );
    },
  );
  it('updates pins and leaves the original file untouched on source failure or malformed instructions', async () => {
    const root = await workspace();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    await skillFile(root, fileCitation.path, 'source bytes');
    await skillFile(root, 'SKILL.md', '# Original\n');
    const file = join(root, 'SKILL.md'),
      env = environment();
    await runCite({ fileSource: fileCitation.path, file }, env);
    await skillFile(root, fileCitation.path, 'changed source bytes');
    await runCite({ fileSource: fileCitation.path, file }, env);
    const updated = await readFile(file, 'utf8');
    expect(parseCitations(updated)).toHaveLength(1);
    expect(parseCitations(updated)[0]!.citation).toMatchObject({
      sha256: digest('changed source bytes'),
    });
    await expect(
      runCite(
        { url: urlCitation.uri, file },
        environment('PRIVATE response', { status: 404 }),
      ),
    ).rejects.toThrow('missing');
    expect(await readFile(file, 'utf8')).toBe(updated);
    await skillFile(root, 'SKILL.md', '<!-- interfacedelta:cite PRIVATE -->');
    await expect(runCite({ url: urlCitation.uri, file }, env)).rejects.toThrow(
      'malformed',
    );
    expect(env.fetch).not.toHaveBeenCalled();
  });
  it('prints without --file, and keeps Git syntax-only even with --fetch', async () => {
    const root = await workspace();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const env = environment();
    const result = await runCite(
      { git: `${gitCitation.repo}@${gitCitation.commit}` },
      env,
    );
    await skillFile(root, 'SKILL.md', result.output);
    expect(
      (
        await runCitations(
          { dir: root, fetch: true, failOn: 'not_checked' },
          env,
        )
      ).exitCode,
    ).toBe(1);
    expect(env.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['cite', '--url'],
    ['cite', '--file-source', '../x', '--fetch'],
    ['cite', '--url', urlCitation.uri, '--file-source', 'docs/x'],
    ['cite', urlCitation.uri, 'tool', '--url', urlCitation.uri],
    ['cite', '--git', `${gitCitation.repo}@${gitCitation.commit}`, 'extra'],
    ['citations', '--fetch', 'true', 'extra'],
  ])('rejects ambiguous or unsupported arguments %j', (...args) =>
    expect(() => parseArguments(args)).toThrow(),
  );
  it('accepts --fetch and all new fail-on statuses', () => {
    expect(parseArguments(['citations', '--fetch', '--json'])).toMatchObject({
      citationFetch: true,
      json: true,
    });
    expect(citationsFailOn('missing,unreachable,not_checked')).toEqual([
      'missing',
      'unreachable',
      'not_checked',
    ]);
  });
});

describe('source output goldens', () => {
  const report: CitationsReport = {
    formatVersion: 'interfacedelta-citations-v1',
    truncated: false,
    filesRead: 1,
    bytesRead: 500,
    toolsChecked: 0,
    citations: [
      {
        path: 'rules/a #%.md',
        line: 1,
        status: 'changed',
        citation: fileCitation,
        currentSha256: 'b'.repeat(64),
      },
      {
        path: 'rules/a #%.md',
        line: 2,
        status: 'not_checked',
        citation: urlCitation,
      },
      {
        path: 'rules/a #%.md',
        line: 3,
        status: 'not_checked',
        citation: gitCitation,
      },
      {
        path: 'rules/a #%.md',
        line: 4,
        status: 'missing',
        citation: { ...urlCitation, label: 'Paper' },
      },
      {
        path: 'rules/a #%.md',
        line: 5,
        status: 'unreachable',
        citation: urlCitation,
      },
      { path: 'rules/a #%.md', line: 6, status: 'malformed' },
    ],
  };
  it('has stable table, JSON and SARIF without content or unsafe locations', () => {
    expect(formatCitations(report)).toMatchSnapshot();
    expect(JSON.stringify(report, null, 2)).toMatchSnapshot();
    expect(citationsToSarif(report)).toMatchSnapshot();
  });
});
