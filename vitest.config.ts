import { defineConfig } from 'vitest/config';
import path from 'node:path';

const r = (p: string) => path.resolve(import.meta.dirname, p);
const alias = {
  '@browserforge/shared': r('packages/shared/src/index.ts'),
  '@browserforge/browser-protocol': r('packages/browser-protocol/src/index.ts'),
  '@browserforge/network-inspector': r('packages/network-inspector/src/index.ts'),
  '@browserforge/api-analyzer': r('packages/api-analyzer/src/index.ts'),
  '@browserforge/client-generator': r('packages/client-generator/src/index.ts'),
  '@browserforge/knowledge': r('packages/knowledge/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], testTimeout: 20_000 } },
      { resolve: { alias }, test: { name: 'security', include: ['tests/security/**/*.test.ts'], testTimeout: 30_000 } },
      { resolve: { alias }, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], testTimeout: 60_000 } },
      { resolve: { alias }, test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false } },
    ],
  },
});
