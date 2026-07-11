import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Resolve a workspace package to its TypeScript source entry so tests run without a build step. */
const src = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@veritrail/core': src('./packages/core/src/index.ts'),
      '@veritrail/sdk': src('./packages/sdk/src/index.ts'),
      '@veritrail/relational-store': src('./packages/relational-store/src/index.ts'),
      '@veritrail/provider-signers': src('./packages/provider-signers/src/index.ts'),
      '@veritrail/provider-monitors': src('./packages/provider-monitors/src/index.ts'),
      '@veritrail/mcp-server': src('./packages/mcp-server/src/index.ts'),
      '@veritrail/receipt': src('./packages/receipt/src/index.ts'),
      '@veritrail/auto-rca': src('./packages/auto-rca/src/index.ts'),
      '@veritrail/policy-simulator': src('./packages/policy-simulator/src/index.ts'),
      '@veritrail/cost-optimizer': src('./packages/cost-optimizer/src/index.ts'),
      '@veritrail/compliance': src('./packages/compliance/src/index.ts'),
      '@veritrail/integrations': src('./packages/integrations/src/index.ts'),
      '@veritrail/integrations-langchain': src('./packages/integrations-langchain/src/index.ts'),
      '@veritrail/control-plane': src('./packages/control-plane/src/index.ts'),
      '@veritrail/agent-reputation': src('./packages/agent-reputation/src/index.ts'),
      '@veritrail/risk-network': src('./packages/risk-network/src/index.ts'),
      '@veritrail/webhook-worker': src('./packages/webhook-worker/src/index.ts'),
      '@veritrail/white-label': src('./packages/white-label/src/index.ts'),
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
