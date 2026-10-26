/* global process, console, URL */
// Runs the built bundle, which unit tests never load. Offline: no target URL.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
