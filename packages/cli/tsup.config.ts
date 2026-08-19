import { defineConfig } from 'tsup';
import { copyFile } from 'node:fs/promises';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  splitting: false,
  minify: true,
  onSuccess: async () => { await copyFile('public/index.d.ts', 'dist/index.d.ts'); },
  clean: true,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  noExternal: [/.*/],
});
