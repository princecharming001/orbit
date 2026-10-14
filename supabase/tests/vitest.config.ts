import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const core = fileURLToPath(new URL('../../packages/core/src/', import.meta.url));

export default defineConfig({
  // the functions import @orbit/core the way scripts/build-functions.mjs resolves it
  resolve: {
    alias: [
      { find: /^@orbit\/core$/, replacement: `${core}index.ts` },
      { find: /^@orbit\/core\/(.*)$/, replacement: `${core}$1.ts` },
    ],
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // each test file boots its own PGlite (WASM, CPU-heavy): one file at a time leaves the CPU to the core and web
    // suites that `pnpm -r test` runs alongside, some of which time themselves
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
