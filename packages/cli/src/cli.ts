import { runCli } from './run';

process.exitCode = await runCli(process.argv.slice(2));
