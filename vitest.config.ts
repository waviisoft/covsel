import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

import { BROWSER_TESTS } from './browser-tests.mjs';

/** Workspace packages resolved to source, so tests run without a build step. */
export const workspaceAlias: Record<string, string> = {
  '@covsel/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
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
  '@covsel/adapter-playwright': fileURLToPath(
    new URL('./packages/adapter-playwright/src/index.ts', import.meta.url),
  ),
  '@covsel/conformance/vitest': fileURLToPath(
    new URL('./packages/conformance/src/vitest.ts', import.meta.url),
  ),
  '@covsel/conformance': fileURLToPath(
    new URL('./packages/conformance/src/index.ts', import.meta.url),
  ),
};

export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: {
    // The action under `actions/` is not a workspace package -- GitHub runs it
    // from a checkout with no install or build step, so it is plain JavaScript
    // with no dependencies -- but its reporting is where a selection becomes a
    // claim someone acts on, and that is worth the same suite as everything else.
    include: [
      'packages/*/test/**/*.test.ts',
      'benchmarks/test/**/*.test.ts',
      'actions/*/test/**/*.test.ts',
    ],
    exclude: [...configDefaults.exclude, ...BROWSER_TESTS],
  },
});
