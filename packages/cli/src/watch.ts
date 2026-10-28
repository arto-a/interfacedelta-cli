import { spawnSync } from 'node:child_process';
import { loadDependencies } from './dependencies';
import { ConfigurationError, InspectionError } from './errors';
import { readJsonFile } from './io';
import { registerSecret } from './secrets';

/**
 * `interfacedelta watch`: hands the repository's dependencies file to the
 * hosted service, which then checks every dependency continuously and
 * decides each change with the same rules. The service never sees Git; this
 * client proves ordering (the stored commit is an ancestor of this one) and
 * the service enforces an atomic version precondition.
 */
export const DEFAULT_API_URL = 'https://interfacedelta.com';
const TIMEOUT_MS = 15_000;

export type WatchOptions = {
  dependencies: string;
  repository?: string;
  ref?: string;
  force: boolean;
  off: boolean;
};

export type WatchEnvironment = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** Runs git with arguments, no shell; returns the exit status and stdout. */
  git: (args: string[]) => { status: number | null; stdout: string };
  now?: () => Date;
};

export type WatchOutcome =
  | {
      status: 'synced';
      repository: string;
      ref: string;
      commitSha: string;
      syncVersion: string;
      monitors: number;
      dependencies: number;
    }
  | {
      status: 'skipped';
      repository: string;
      ref: string;
      commitSha: string;
      storedCommitSha: string;
      reason: 'behind' | 'diverged';
    }
  | { status: 'unwatched'; repository: string; ref: string };

export const defaultGit: WatchEnvironment['git'] = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return { status: result.status, stdout: (result.stdout ?? '').trim() };
};

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The service's ref rule: Git-safe characters, no `..` or `@{`, at most 255. */
export const validRef = (ref: string) =>
  ref.length >= 1 &&
  ref.length <= 255 &&
  ![...ref].some((c) => c.charCodeAt(0) < 33 || '~^:?*[\\'.includes(c)) &&
  !ref.includes('..') &&
  !ref.includes('@{');

function repositoryFromRemote(git: WatchEnvironment['git']) {
  const remote = git(['remote', 'get-url', 'origin']);
  if (remote.status !== 0) return undefined;
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
    remote.stdout,
  );
  return match?.[1];
}

/** The branch this run is on, or nothing for a tag or detached checkout. */
function currentBranch(environment: WatchEnvironment) {
  const { env, git } = environment;
  if (env.GITHUB_ACTIONS === 'true' || env.GITHUB_REF_TYPE)
    return env.GITHUB_REF_TYPE === 'branch' ? env.GITHUB_REF_NAME : undefined;
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return branch.status === 0 && branch.stdout ? branch.stdout : undefined;
}

/**
 * Where to sync: flags, then GitHub Actions variables, then the local clone.
 * A tag or detached checkout needs --ref: it never falls back to a branch.
 */
export function resolveWatchTarget(
  options: WatchOptions,
  environment: WatchEnvironment,
) {
  const { env, git } = environment;
  const repository =
    options.repository ?? env.GITHUB_REPOSITORY ?? repositoryFromRemote(git);
  if (!repository || !REPOSITORY.test(repository))
    throw new ConfigurationError(
      'watch needs the repository as owner/name: pass --repository, or run it in GitHub Actions or a clone whose origin is on GitHub.',
    );
  const ref = options.ref ?? currentBranch(environment);
  if (!ref)
    throw new ConfigurationError(
      'This checkout is not on a branch (a tag or detached commit): pass --ref with the branch to watch.',
    );
  if (!validRef(ref)) throw new ConfigurationError(`Not a valid ref: ${ref}`);
  if (options.off) return { repository, ref, commitSha: undefined };
  const head = git(['rev-parse', 'HEAD']);
  const commitSha =
    env.GITHUB_SHA ?? (head.status === 0 ? head.stdout : undefined);
  if (!commitSha || !COMMIT.test(commitSha))
    throw new ConfigurationError(
      'watch needs the current commit: run it in a Git clone or in GitHub Actions.',
    );
  return { repository, ref, commitSha };
}

/** An https origin without credentials, from a variable or its default. */
function httpsOrigin(
  name: string,
  value: string | undefined,
  fallback: string,
) {
  const raw = value?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError(`${name} is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new ConfigurationError(
      `${name} must be an https:// origin without credentials.`,
    );
  return url;
}

function apiBase(env: WatchEnvironment['env']) {
  return httpsOrigin(
    'INTERFACEDELTA_API_URL',
    env.INTERFACEDELTA_API_URL,
    DEFAULT_API_URL,
  ).origin;
}

function apiToken(env: WatchEnvironment['env']) {
  const token = env.INTERFACEDELTA_API_TOKEN?.trim();
  if (!token)
    throw new ConfigurationError(
      'watch needs INTERFACEDELTA_API_TOKEN: an InterfaceDelta API token with the lockfiles:write scope for this repository.',
    );
  registerSecret(token);
  return token;
}

type Stored = { syncVersion: string; commitSha: string | null };

async function request(
  environment: WatchEnvironment,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await environment.fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new InspectionError(
      'Could not reach InterfaceDelta. Check the network and try again.',
    );
  }
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One message per documented failure; never echoes the token. */
async function failure(response: Response): Promise<never> {
  const body = await bodyOf(response);
  // The API answers errors as { error: { code, message } }.
  const error =
    body.error && typeof body.error === 'object'
      ? (body.error as Record<string, unknown>)
      : {};
  const text =
    typeof error.message === 'string'
      ? error.message
      : typeof body.message === 'string'
        ? body.message
        : undefined;
  const message = text ? ` ${text}` : '';
  if (response.status === 401)
    throw new ConfigurationError(
      'InterfaceDelta refused the API token. Check INTERFACEDELTA_API_TOKEN.',
    );
  if (response.status === 403)
    throw new ConfigurationError(
      `This token cannot watch this repository and ref, or the ref is not enabled for watching.${message}`,
    );
  if (response.status === 422 && body.status === 'monitor_limit')
    throw new ConfigurationError(
      `Watching this file needs ${String(body.count)} monitors; your plan allows ${String(body.limit)}. Nothing was changed.`,
    );
  if (response.status === 422 && body.status === 'lockfile_limit')
    throw new ConfigurationError(
      `Your plan allows ${String(body.limit)} watched lockfiles. Nothing was changed.`,
    );
  if (response.status === 400 || response.status === 422)
    throw new ConfigurationError(
      `InterfaceDelta rejected the dependencies file.${message}`,
    );
  throw new InspectionError(
    `InterfaceDelta answered ${response.status}.${message}`,
  );
}

function lockfileUrl(base: string, repository: string, ref: string) {
  return `${base}/api/v1/lockfiles/${encodeURIComponent(repository)}?ref=${encodeURIComponent(ref)}`;
}

async function readStored(
  environment: WatchEnvironment,
  base: string,
  token: string,
  repository: string,
  ref: string,
): Promise<Stored> {
  const response = await request(
    environment,
    lockfileUrl(base, repository, ref),
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (response.status === 404) return { syncVersion: '0', commitSha: null };
  if (!response.ok) return failure(response);
  const body = await bodyOf(response);
  const etag = response.headers.get('etag')?.replace(/^"|"$/g, '');
  const syncVersion =
    etag ?? (typeof body.syncVersion === 'string' ? body.syncVersion : '');
  if (!syncVersion)
    throw new InspectionError('InterfaceDelta returned no sync version.');
  return {
    syncVersion,
    commitSha: typeof body.commitSha === 'string' ? body.commitSha : null,
  };
}

/**
 * Whether the stored commit is an ancestor of this one. Locally with Git;
 * in a shallow GitHub Actions checkout through the compare API with the
 * job's own token.
 */
async function ordering(
  environment: WatchEnvironment,
  repository: string,
  stored: string,
  current: string,
): Promise<'ahead' | 'behind' | 'diverged'> {
  if (stored === current) return 'ahead';
  const { git, env } = environment;
  const known = git(['cat-file', '-e', `${stored}^{commit}`]).status === 0;
  if (known) {
    if (git(['merge-base', '--is-ancestor', stored, current]).status === 0)
      return 'ahead';
    if (git(['merge-base', '--is-ancestor', current, stored]).status === 0)
      return 'behind';
    // In a shallow clone both commits can be present while the history that
    // joins them is not: unknown, not diverged.
    const shallow = git(['rev-parse', '--is-shallow-repository']);
    if (!(shallow.status === 0 && shallow.stdout === 'true')) return 'diverged';
  }
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (githubToken) {
    registerSecret(githubToken);
    const api = httpsOrigin(
      'GITHUB_API_URL',
      env.GITHUB_API_URL,
      'https://api.github.com',
    );
    const base = api.pathname.replace(/\/$/, '');
    const response = await request(
      environment,
      `${api.origin}${base}/repos/${repository}/compare/${stored}...${current}`,
      {
        headers: {
          authorization: `Bearer ${githubToken}`,
          accept: 'application/vnd.github+json',
        },
      },
    );
    if (response.ok) {
      const status = (await bodyOf(response)).status;
      if (status === 'ahead' || status === 'identical') return 'ahead';
      if (status === 'behind') return 'behind';
      if (status === 'diverged') return 'diverged';
    }
  }
  throw new ConfigurationError(
    `Cannot tell whether ${current.slice(0, 7)} is newer than the watched ${stored.slice(0, 7)}: fetch the history (actions/checkout with fetch-depth: 0), give GITHUB_TOKEN, or pass --force.`,
  );
}

export async function runWatch(
  options: WatchOptions,
  environment: WatchEnvironment,
): Promise<WatchOutcome> {
  const target = resolveWatchTarget(options, environment);
  const { repository, ref } = target;
  const base = apiBase(environment.env);
  const token = apiToken(environment.env);
  if (options.off) {
    const stored = await readStored(environment, base, token, repository, ref);
    const response = await request(
      environment,
      lockfileUrl(base, repository, ref),
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${token}`,
          'if-match': `"${stored.syncVersion}"`,
        },
      },
    );
    if (response.status !== 204 && response.status !== 404)
      return failure(response);
    return { status: 'unwatched', repository, ref };
  }
  const commitSha = target.commitSha!;
  // Fail fast with the CLI's own messages; the service validates again.
  const file = await loadDependencies(
    options.dependencies,
    (environment.now ?? (() => new Date()))(),
  );
  const document = await readJsonFile(options.dependencies, 'Dependencies');
  for (let attempt = 0; attempt < 2; attempt++) {
    const stored = await readStored(environment, base, token, repository, ref);
    if (stored.commitSha && !options.force) {
      const order = await ordering(
        environment,
        repository,
        stored.commitSha,
        commitSha,
      );
      if (order !== 'ahead')
        return {
          status: 'skipped',
          repository,
          ref,
          commitSha,
          storedCommitSha: stored.commitSha,
          reason: order,
        };
    }
    const response = await request(
      environment,
      `${base}/api/v1/lockfiles/${encodeURIComponent(repository)}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'if-match': `"${stored.syncVersion}"`,
        },
        body: JSON.stringify({
          ref,
          commitSha,
          force: options.force,
          document,
        }),
      },
    );
    if (response.status === 409) continue;
    if (!response.ok) return failure(response);
    const body = await bodyOf(response);
    return {
      status: 'synced',
      repository,
      ref,
      commitSha,
      syncVersion: String(body.syncVersion ?? ''),
      monitors: Number(body.monitors ?? body.monitorCount ?? 0),
      dependencies: file.dependencies.length,
    };
  }
  throw new InspectionError(
    'Another sync of this repository changed it twice while this one ran; run watch again.',
  );
}

export function formatWatch(outcome: WatchOutcome): string {
  const where = `${outcome.repository}@${outcome.ref}`;
  if (outcome.status === 'unwatched')
    return `Stopped watching ${where}. Earlier decisions stay in your history.`;
  if (outcome.status === 'skipped')
    return `Skipped: ${where} is already watched at ${outcome.storedCommitSha.slice(0, 7)}, which is ${outcome.reason === 'behind' ? 'newer than' : 'not an ancestor of'} ${outcome.commitSha.slice(0, 7)}. Pass --force to replace it.`;
  return `Watching ${outcome.dependencies} ${outcome.dependencies === 1 ? 'dependency' : 'dependencies'} for ${where} at ${outcome.commitSha.slice(0, 7)}. InterfaceDelta checks them continuously and delivers each decision to its owner.`;
}
