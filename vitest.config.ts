import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Tests that need a real browser, which `pnpm test` must not depend on having.
 *
 * The Playwright adapter's conformance suite drives Chromium against a served
 * application, so it is run on its own by `pnpm test:browser` — and CI runs it,
 * because a conformance suite nothing executes is a conformance suite that
 * certifies nothing.
 */
export const BROWSER_TESTS = ['packages/adapter-playwright/test/conformance.test.ts'];

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
    include: ['packages/*/test/**/*.test.ts', 'benchmarks/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...BROWSER_TESTS],
  },
});
