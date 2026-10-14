import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // each SQL test file boots its own PGlite
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
