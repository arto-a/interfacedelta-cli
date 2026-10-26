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
  onSuccess: async () => {
    await copyFile('public/index.d.ts', 'dist/index.d.ts');
  },
  clean: true,
  sourcemap: false,
  // Bundled CommonJS dependencies (undici via jsonld) call require(); an ESM
  // bundle has none, so provide Node's.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __interfacedeltaRequire } from 'node:module';\nconst require = __interfacedeltaRequire(import.meta.url);",
  },
  noExternal: [/.*/],
});
