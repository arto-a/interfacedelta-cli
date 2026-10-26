import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computePassportFingerprint } from '@interfacedelta/core';
import type { AgentPassport, DiscoveryReport } from '@interfacedelta/contracts';
import {
  assertCredentialAccepted,
  credentialFor,
  parseTokenBindings,
  type Inspector,
} from './core';
import { loadDependencies } from './dependencies';
import {
  ConfigurationError,
  CredentialError,
  CredentialUnavailableError,
  InspectionError,
} from './errors';
import { runCli } from './run';
import { redact } from './secrets';
import { sanitizeTerminal } from './sanitize';
import { discoveryFixture, passportFixture } from './test-fixture';

const TOKEN = 'idt-test-token.0123456789abcdef';
const ENDPOINT = 'https://mcp.example.com/mcp';
const dirs: string[] = [];
const envs: string[] = [];
afterEach(async () => {
  for (const name of envs.splice(0)) delete process.env[name];
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const setEnv = (name: string, value: string) => {
  process.env[name] = value;
  envs.push(name);
};
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'interfacedelta-cred-'));
  dirs.push(dir);
  return dir;
};

function withTool(description: string): AgentPassport {
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
    id: 'capability:search',
    kind: 'mcp.tool',
    protocol: 'mcp',
    protocolKey: 'search',
    name: 'search',
    description,
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
}

/** Records the token each call received; returns `passport`. */
function recording(passport: () => AgentPassport) {
  const tokens: (string | undefined)[] = [];
  const inspector: Inspector = async (_url, _endpoint, _page, token) => {
    tokens.push(token);
    return passport();
  };
  return { tokens, inspector };
}

const io = (out: string[] = [], err: string[] = []) => ({
  stdout: (value: string) => out.push(value),
  stderr: (value: string) => err.push(value),
});

const VAR = 'INTERFACEDELTA_TOKEN_TEST';
const BINDING = `https://mcp.example.com=${VAR}`;
const bindings = parseTokenBindings([BINDING]);

describe('token bindings', () => {
  it('accept only HTTPS origins and INTERFACEDELTA_TOKEN_ variables', () => {
    expect(bindings).toEqual([
      { origin: 'https://mcp.example.com', variable: VAR },
    ]);
    for (const value of [
      'https://mcp.example.com=GITHUB_TOKEN',
      'https://mcp.example.com=ACTIONS_RUNTIME_TOKEN',
      'https://mcp.example.com=HOME',
      'https://mcp.example.com=INTERFACEDELTA_TOKEN_',
      'http://mcp.example.com=INTERFACEDELTA_TOKEN_X',

      'https://user@mcp.example.com=INTERFACEDELTA_TOKEN_X',
      'https://127.0.0.1=INTERFACEDELTA_TOKEN_X',
      'INTERFACEDELTA_TOKEN_X',
    ])
      expect(() => parseTokenBindings([value]), value).toThrow(
        ConfigurationError,
      );
    expect(() =>
      parseTokenBindings([BINDING, `https://MCP.example.com=${VAR}_2`]),
    ).toThrow('Two token bindings');
  });

  it('bind an exact endpoint when the binding has a path', () => {
    const exact = parseTokenBindings([`${ENDPOINT}=${VAR}`]);
    const env = { [VAR]: TOKEN };
    expect(credentialFor(exact, ENDPOINT, env)).toBe(TOKEN);
    expect(
      credentialFor(exact, 'https://mcp.example.com/other/mcp', env),
    ).toBeUndefined();
  });

  it('send a token only to explicit endpoints on the bound origin', () => {
    const env = { [VAR]: TOKEN };
    expect(credentialFor(bindings, ENDPOINT, env)).toBe(TOKEN);
    expect(credentialFor(bindings, 'https://mcp.example.com/v2/mcp', env)).toBe(
      TOKEN,
    );
    // The repository chooses endpoints, never which token reaches them.
    expect(credentialFor(bindings, 'https://evil.example.com/mcp', env)).toBe(
      undefined,
    );
    expect(credentialFor(bindings, null, env)).toBeUndefined();
    expect(credentialFor([], ENDPOINT, env)).toBeUndefined();
  });

  it('validate the value without ever echoing it', () => {
    expect(() => credentialFor(bindings, ENDPOINT, {})).toThrow(
      CredentialError,
    );
    for (const value of [
      `${TOKEN}\n`,
      `\x1b[A\x1b[A${TOKEN}`,
      'qz81',
      'not a valid token value',
    ])
      try {
        credentialFor(bindings, ENDPOINT, { [VAR]: value });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as Error).message).not.toContain(value.trim());
      }
    expect(redact(`echo ${TOKEN} twice ${TOKEN}`)).toBe('echo *** twice ***');
  });

  it('skip only in a pull request from a fork', async () => {
    const dir = await tempDir();
    const event = join(dir, 'event.json');
    const pr = (head: string) =>
      writeFile(
        event,
        JSON.stringify({
          pull_request: {
            head: { repo: { full_name: head } },
            base: { repo: { full_name: 'acme/app' } },
          },
        }),
      );
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event };
    await pr('stranger/app');
    expect(() => credentialFor(bindings, ENDPOINT, env)).toThrow(
      CredentialUnavailableError,
    );
    await pr('acme/app');
    expect(() => credentialFor(bindings, ENDPOINT, env)).toThrow(
      CredentialError,
    );
    expect(() =>
      credentialFor(bindings, ENDPOINT, { ...env, GITHUB_EVENT_NAME: 'push' }),
    ).toThrow(CredentialError);
    // Dependabot pull requests and deleted forks also run without secrets.
    expect(() =>
      credentialFor(bindings, ENDPOINT, {
        ...env,
        GITHUB_ACTOR: 'dependabot[bot]',
      }),
    ).toThrow(CredentialUnavailableError);
    await writeFile(
      event,
      JSON.stringify({
        pull_request: {
          head: { repo: null },
          base: { repo: { full_name: 'acme/app' } },
        },
      }),
    );
    expect(() => credentialFor(bindings, ENDPOINT, env)).toThrow(
      CredentialUnavailableError,
    );
  });

  it('redacts a token before truncation can split it', () => {
    credentialFor(bindings, ENDPOINT, { [VAR]: TOKEN });
    const printed = sanitizeTerminal(`${'x'.repeat(490)}${TOKEN}`);
    expect(printed).not.toContain(TOKEN.slice(0, 8));
  });
});

describe('signed-in checks', () => {
  const target = ['https://mcp.example.com', '--mcp-endpoint', ENDPOINT];

  it('refuse a binding that no explicit endpoint uses', async () => {
    setEnv(VAR, TOKEN);
    const { tokens, inspector } = recording(() => withTool('Search.'));
    for (const argv of [
      // No --mcp-endpoint: an MCP URL alone is never sent the token.
      ['inspect', 'https://mcp.example.com/mcp/', '--token', BINDING],
      ['inspect', ...target, '--token', `https://other.example.com=${VAR}`],
    ]) {
      const err: string[] = [];
      expect(await runCli(argv, { ...io([], err), inspector })).toBe(2);
      expect(err.join('')).toContain('No explicit MCP endpoint matches');
    }
    expect(tokens).toEqual([]);
    const dir = await tempDir();
    const path = join(dir, 'dependencies.json');
    await writeFile(
      path,
      JSON.stringify({
        formatVersion: 'interfacedelta-dependencies-v1',
        dependencies: [
          {
            name: 'public',
            url: 'https://mcp.example.com',
            baseline: 'p.json',
          },
        ],
      }),
    );
    expect(
      await runCli(['check', '--dependencies', path, '--token', BINDING], {
        ...io(),
        inspector,
      }),
    ).toBe(2);
  });

  it('ignore a dependencies file that tries to name a token', async () => {
    const dir = await tempDir();
    const path = join(dir, 'dependencies.json');
    await writeFile(
      path,
      JSON.stringify({
        formatVersion: 'interfacedelta-dependencies-v1',
        dependencies: [
          {
            name: 'evil',
            url: 'https://evil.example.com',
            mcpEndpoint: 'https://evil.example.com/mcp',
            baseline: 'evil.json',
            auth: { bearerTokenEnv: 'GITHUB_TOKEN' },
          },
        ],
      }),
    );
    await expect(loadDependencies(path)).rejects.toThrow(ConfigurationError);
  });

  it('send the bound token, record it in the baseline, and refuse a mismatched check', async () => {
    setEnv(VAR, TOKEN);
    const dir = await tempDir();
    const baseline = join(dir, 'p.json');
    const { tokens, inspector } = recording(() => withTool('Search.'));
    expect(
      await runCli(
        ['baseline', ...target, '--output', baseline, '--token', BINDING],
        { ...io(), inspector },
      ),
    ).toBe(0);
    const written = await readFile(baseline, 'utf8');
    expect(JSON.parse(written).authenticated).toBe(true);
    expect(written).not.toContain(TOKEN);
    const err: string[] = [];
    expect(
      await runCli(['check', ...target, '--baseline', baseline], {
        ...io([], err),
        inspector,
      }),
    ).toBe(2);
    expect(err.join('')).toContain('recorded with a bearer token');
    expect(
      await runCli(
        ['check', ...target, '--baseline', baseline, '--token', BINDING],
        { ...io(), inspector },
      ),
    ).toBe(0);
    expect(tokens).toEqual([TOKEN, TOKEN]);
    const out: string[] = [];
    await runCli(['inspect', ...target, '--token', BINDING, '--json'], {
      ...io(out),
      inspector,
    });
    expect(JSON.parse(out.join('')).authenticated).toBe(true);
  });

  it('fail on a missing token even with on-error: warn', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.interfacedelta'));
    const path = join(dir, '.interfacedelta', 'dependencies.json');
    await writeFile(
      path,
      JSON.stringify({
        formatVersion: 'interfacedelta-dependencies-v1',
        dependencies: [
          {
            name: 'gh',
            url: 'https://mcp.example.com',
            mcpEndpoint: ENDPOINT,
            baseline: 'gh.json',
          },
        ],
      }),
    );
    const out: string[] = [];
    expect(
      await runCli(
        [
          'check',
          '--dependencies',
          path,
          '--json',
          '--on-error',
          'warn',
          '--token',
          BINDING,
        ],
        { ...io(out), inspector: async () => passportFixture() },
      ),
    ).toBe(2);
    expect(JSON.parse(out.join('')).dependencies[0].error).toMatchObject({
      kind: 'credentials',
      message: `${VAR} is not set.`,
    });
  });

  it('refuse to write a baseline that would contain the token and redact the terminal', async () => {
    setEnv(VAR, TOKEN);
    const dir = await tempDir();
    const baseline = join(dir, 'p.json');
    const echoing = async () => withTool(`Authorized as ${TOKEN}.`);
    const err: string[] = [];
    expect(
      await runCli(
        ['baseline', ...target, '--token', BINDING, '--output', baseline],
        { ...io([], err), inspector: echoing },
      ),
    ).toBe(2);
    expect(err.join('')).toContain('echoed it');
    expect(await stat(baseline).catch(() => null)).toBeNull();
    const out: string[] = [];
    expect(
      await runCli(['inspect', ...target, '--token', BINDING, '--json'], {
        ...io(out),
        inspector: echoing,
      }),
    ).toBe(0);
    expect(out.join('')).toContain('Authorized as ***.');
    expect(out.join('')).not.toContain(TOKEN);
  });
});

describe('credential acceptance', () => {
  const report = (candidate: Record<string, unknown> | null): DiscoveryReport =>
    ({
      ...discoveryFixture,
      mcp: {
        ...discoveryFixture.mcp,
        candidates: candidate ? [{ endpoint: ENDPOINT, ...candidate }] : [],
      },
    }) as unknown as DiscoveryReport;
  const answered = (httpStatus: number) => ({
    network: { responses: [{ httpStatus }] },
  });

  it('accepts only a working signed-in session', () => {
    for (const status of ['valid', 'payment_required', 'truncated'])
      expect(() =>
        assertCredentialAccepted(report({ status }), ENDPOINT, true),
      ).not.toThrow();
  });

  it('fails when the token was never sent, refused, redirected, or rejected another way', () => {
    expect(() =>
      assertCredentialAccepted(report({ status: 'valid' }), ENDPOINT, false),
    ).toThrow('never requested');
    expect(() =>
      assertCredentialAccepted(
        report({ status: 'valid' }),
        ENDPOINT,
        true,
        'https://mcp.example.com/mcp/',
      ),
    ).toThrow('redirected');
    expect(() =>
      assertCredentialAccepted(report(null), ENDPOINT, true),
    ).toThrow('not observed');
    for (const httpStatus of [401, 403])
      expect(() =>
        assertCredentialAccepted(
          report({
            status: 'auth_required',
            auth: { httpStatus },
            ...answered(httpStatus),
          }),
          ENDPOINT,
          true,
        ),
      ).toThrow(`refused the bearer token (HTTP ${httpStatus})`);
    // GitHub answers a malformed token with 400 invalid_token, not 401.
    for (const httpStatus of [400, 404, 503])
      expect(() =>
        assertCredentialAccepted(
          report({ status: 'unreachable', ...answered(httpStatus) }),
          ENDPOINT,
          true,
        ),
      ).toThrow(CredentialError);
  });

  it('reports an endpoint that never answered as an outage', () => {
    expect(() =>
      assertCredentialAccepted(
        report({ status: 'unreachable' }),
        ENDPOINT,
        true,
      ),
    ).toThrow(InspectionError);
  });
});
