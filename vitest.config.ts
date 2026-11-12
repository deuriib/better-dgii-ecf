import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // Better Auth keeps a module-level secret cache; a shared process keeps the
    // suite fast and forces us to build instances explicitly per test.
    pool: 'threads',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // `src/client.ts` is a thin inference shim: it has no runtime branches to
      // cover, so it is measured through the type-level `tsc` gate instead.
      exclude: ['src/client.ts', 'src/types.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
