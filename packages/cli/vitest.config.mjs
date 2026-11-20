import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: [
      fileURLToPath(new URL('./src/test-network-block.cjs', import.meta.url)),
    ],
    testTimeout: 30_000,
  },
});
