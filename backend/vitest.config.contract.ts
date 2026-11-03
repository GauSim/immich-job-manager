import { defineConfig } from 'vitest/config';

/**
 * Contract tests against a real, throwaway Immich v3 (seeded by
 * tools/immich-spike `npm run seed`). Skipped unless IMMICH_CONTRACT_URL and
 * IMMICH_CONTRACT_KEY are set. Never point them at your real library.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/contract/**/*.contract-spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
