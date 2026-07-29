/**
 * covsel's configuration for covsel's own suite.
 *
 * This is a real adoption of the tool, not a fixture: the `covsel map` workflow
 * records against it on every push to `main`, and the `select` job on every pull
 * request selects against the map that produces. It is written as `.js` rather
 * than `covsel.json` because two of the choices below are only defensible with
 * the reasoning attached.
 */
export default {
  // Recorded and selected through Vitest's own coverage, since Vitest evaluates
  // transformed sources and the generic wrap would never see `packages/*/src`.
  // Named here rather than passed as `--adapter` on every invocation.
  adapter: 'vitest',

  // The suite vitest itself runs. The golden example end-to-end scripts under
  // examples/ are shell, driven by their own CI steps, and are not selected.
  testGlobs: ['packages/*/test/**/*.test.ts'],

  // Only the packages' own sources. Written with a slash on purpose: a slash-less
  // glob also matches by basename anywhere in the tree, which would pull every
  // fixture and example file of the same name into the map (see #20).
  sourceGlobs: ['packages/*/src/**'],

  /*
   * Tests whose coverage the recorder cannot see, and which therefore must run
   * whatever the diff says.
   *
   * The Vitest adapter records what Vitest's own V8 coverage provider reports,
   * which is what ran *inside* the Vitest process. These three exercise covsel by
   * spawning something — the built CLI, a `node` process under
   * NODE_V8_COVERAGE, a process driven through the inspector — so the code they
   * are really testing runs where that provider cannot see it, and each records
   * zero covered sources.
   *
   * A zero-source entry reads to the selector as "this test covers nothing",
   * which means it would never be selected: edit `observer.ts` and the test that
   * exists to prove the observer works would sit the run out. Listing them here
   * is the honest answer while the adapter's `observes` claim stays `**`.
   *
   * Recomputing this list is mechanical: record, then look for entries whose
   * `files` array is empty.
   */
  alwaysRun: [
    'packages/cli/test/built-artifact.test.ts',
    'packages/core/test/coverage-observation.test.ts',
    'packages/core/test/inspector-observation.test.ts',
  ],

  /*
   * A change to any of these forces a full run.
   *
   * The first four are covsel's defaults, restated because setting the field
   * replaces them rather than adding to them. The rest are this repository's own:
   * the vitest config decides what the suite even is, this file decides what
   * selection means, and the shims and the CLI entry point run in child processes
   * the recorder cannot observe — so a change to one of them cannot be attributed
   * to any test, and the only sound answer is to run everything.
   */
  sentinels: [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig*.json',
    'yarn.lock',
    'vitest.config.ts',
    'covsel.config.js',
    'packages/*/src/shim.js',
    'packages/cli/src/bin.ts',
  ],

  granularity: 'block',
};
