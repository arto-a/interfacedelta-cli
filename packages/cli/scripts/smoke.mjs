/* global process, console, URL */
// Runs the built bundle, which unit tests never load. Offline: no target URL.
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const run = (...args) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const checks = [
  [run('version'), 0, `${version}\n`],
  [run('--help'), 0, `InterfaceDelta CLI ${version}`],
  [run('inspect', 'http://127.0.0.1'), 2, 'Only HTTPS URLs are supported.'],
  [
    run('check', '--dependencies', '/nonexistent/dependencies.json'),
    2,
    'could not be read',
  ],
];
const library = await import(new URL('../dist/index.js', import.meta.url).href);
if (library.CLI_VERSION !== version)
  throw new Error(
    `dist/index.js reports ${library.CLI_VERSION}, expected ${version}`,
  );
for (const [result, status, text] of checks)
  if (
    result.status !== status ||
    !`${result.stdout}${result.stderr}`.includes(text)
  )
    throw new Error(
      `Smoke check failed (status ${result.status}, expected ${status}):\n${result.stdout}${result.stderr}`.slice(
        0,
        2000,
      ),
    );
console.log(`interfacedelta ${version} bundle smoke passed`);

const directory = mkdtempSync(join(tmpdir(), 'interfacedelta-policy-smoke-'));
try {
  const dependencies = join(directory, 'dependencies.json');
  writeFileSync(
    dependencies,
    JSON.stringify({
      formatVersion: 'interfacedelta-dependencies-v1',
      dependencies: [
        {
          name: 'fixture',
          url: 'https://example.com',
          baseline: 'missing.json',
        },
      ],
    }),
  );
  for (const format of ['github', 'generic']) {
    const result = run(
      'policy',
      'export',
      '--format',
      format,
      '--dependencies',
      dependencies,
      '--no-check',
    );
    if (result.status !== 0)
      throw new Error(`Offline export failed: ${result.stderr}`);
    const policy = JSON.parse(result.stdout);
    // Unchecked entries are never allowlisted: both formats list them as
    // excluded for review.
    const entries = policy.excluded;
    const allowed = format === 'github' ? [] : policy.servers;
    if (
      allowed.length !== 0 ||
      entries.length !== 1 ||
      entries[0].decision !== 'review' ||
      entries[0].reasons[0] !== 'not-checked'
    )
      throw new Error('Offline export did not require review.');
  }
  const live = run(
    'policy',
    'export',
    '--format',
    'generic',
    '--dependencies',
    dependencies,
  );
  if (
    live.status !== 2 ||
    JSON.parse(live.stdout).servers.length !== 0 ||
    JSON.parse(live.stdout).excluded[0]?.decision !== 'review'
  )
    throw new Error(
      'Missing baseline did not preserve configuration exit and review policy.',
    );
  console.log('policy export bundle fixtures: 3 passed');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
