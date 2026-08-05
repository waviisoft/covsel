import { defineConfig } from 'vitest/config';

import { BROWSER_TESTS, workspaceAlias } from './vitest.config.js';

/**
 * The tests that drive a real browser, split out of `pnpm test` so the ordinary
 * suite needs nothing installed but Node.
 *
 * Only the Playwright adapter's conformance suite lives here. It records against
 * Chromium and a served application, so every check pays for a browser launch
 * and an application boot — which is why it runs on its own, serially, in its own
 * CI job. Nothing here may be skipped when the browser is missing: a conformance
 * suite that quietly passes on a machine without Chromium certifies nothing.
 */
export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: {
    include: BROWSER_TESTS,
    // One browser and one application at a time. The fixture's server binds a
    // fixed port, because Playwright has to be told the URL before it starts.
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
