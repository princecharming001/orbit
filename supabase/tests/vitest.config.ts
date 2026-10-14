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
    // each test file boots its own PGlite (WASM, CPU-heavy), one file at a time. package.json lists @orbit/core and
    // @orbit/web so `pnpm -r test` starts this suite only after theirs, whose timed checks need the CPU to themselves
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
