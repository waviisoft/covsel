import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to source so tests run without a build step.
      '@covsel/core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url),
      ),
      '@covsel/adapter-generic': fileURLToPath(
        new URL('./packages/adapter-generic/src/index.ts', import.meta.url),
      ),
      '@covsel/adapter-vitest': fileURLToPath(
        new URL('./packages/adapter-vitest/src/index.ts', import.meta.url),
      ),
      '@covsel/adapter-jest': fileURLToPath(
        new URL('./packages/adapter-jest/src/index.ts', import.meta.url),
      ),
      '@covsel/adapter-node-test': fileURLToPath(
        new URL('./packages/adapter-node-test/src/index.ts', import.meta.url),
      ),
      '@covsel/adapter-mocha': fileURLToPath(
        new URL('./packages/adapter-mocha/src/index.ts', import.meta.url),
      ),
      '@covsel/adapter-cucumber': fileURLToPath(
        new URL('./packages/adapter-cucumber/src/index.ts', import.meta.url),
      ),
      '@covsel/conformance/vitest': fileURLToPath(
        new URL('./packages/conformance/src/vitest.ts', import.meta.url),
      ),
      '@covsel/conformance': fileURLToPath(
        new URL('./packages/conformance/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
