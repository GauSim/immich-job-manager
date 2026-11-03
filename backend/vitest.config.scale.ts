import { defineConfig } from 'vitest/config';

/** Opt-in scale test (`npm run test:scale`): 100k fake assets with sample originals. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/scale/**/*.scale-spec.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // GC between measurements (retained vs. peak heap).
    execArgv: ['--expose-gc'],
  },
});
