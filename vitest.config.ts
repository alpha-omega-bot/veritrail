import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Resolve a workspace package to its TypeScript source entry so tests run without a build step. */
const src = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@veritrail/core': src('./packages/core/src/index.ts'),
      '@veritrail/sdk': src('./packages/sdk/src/index.ts'),
      '@veritrail/audit': src('./packages/modules/audit/src/index.ts'),
      '@veritrail/permissions': src('./packages/modules/permissions/src/index.ts'),
      '@veritrail/spend-guard': src('./packages/modules/spend-guard/src/index.ts'),
      '@veritrail/rollback': src('./packages/modules/rollback/src/index.ts'),
      '@veritrail/forensics': src('./packages/modules/forensics/src/index.ts'),
      '@veritrail/evidence': src('./packages/modules/evidence/src/index.ts'),
      '@veritrail/decision-memory': src('./packages/modules/decision-memory/src/index.ts'),
      '@veritrail/vendor-risk': src('./packages/modules/vendor-risk/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/**'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test/**', '**/index.ts', '**/*.d.ts'],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
});
