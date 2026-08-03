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
  //
  // By path, not by package name, and deliberately so: adding
  // `@covsel/adapter-vitest` to the root manifest puts it in the repository's own
  // `node_modules`, which changes how `covsel init` resolves it from a throwaway
  // project and breaks the CLI tests that cover "already set up". This repository
  // is the adapter's source, not a consumer of a published copy, so pointing at
  // the workspace directory is both accurate and inert.
  adapter: './packages/adapter-vitest',

  // The suite vitest itself runs. The golden example end-to-end scripts under
  // examples/ are shell, driven by their own CI steps, and are not selected.
  testGlobs: ['packages/*/test/**/*.test.ts'],

  // Only the packages' own sources. Written with a slash on purpose: a slash-less
  // glob also matches by basename anywhere in the tree, which would pull every
  // fixture and example file of the same name into the map (see #20).
  sourceGlobs: ['packages/*/src/**'],

  /*
   * Tests whose coverage the recorder cannot see, named here as well as left to
   * selection to work out.
   *
   * The Vitest adapter records what Vitest's own V8 coverage provider reports,
   * which is what ran *inside* the Vitest process. These three exercise covsel by
   * spawning something — the built CLI, a `node` process under
   * NODE_V8_COVERAGE, a process driven through the inspector — so the code they
   * are really testing runs where that provider cannot see it, and each records
   * zero covered sources.
   *
   * Selection now runs a test whose entry credits no source, because an entry
   * that matches no possible change is unknown coverage rather than a
   * measurement — so a fourth test becoming child-process-only is caught on its
   * own, which is what this list could never do. Keeping the three is belt and
   * braces, and cheap: it does not depend on their entries staying exactly
   * empty, and an entry that picks up one incidental in-process source would
   * stop qualifying while still missing everything it actually tests.
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
   * the vitest config decides what the suite even is, and the shims and the CLI
   * entry point run in child processes the recorder cannot observe — so a change
   * to one of them cannot be attributed to any test, and the only sound answer is
   * to run everything.
   *
   * This file is deliberately not among them, and listing it would be a choice
   * with a cost. Selection already asks about it, ahead of this list and without
   * consulting it, and asks a better question than a path match can: the map
   * records a digest of every value it was recorded under, so a change here
   * forces a full run when it moves one of them and not when it moves a comment.
   * Naming it as a sentinel would only take that back, and every edit to the
   * prose above would cost the whole suite again.
   *
   * Editing the list itself does force one, since `sentinels` is among the
   * values compared -- which is the point of comparing it, because this very
   * edit removed a file from the list.
   */
  sentinels: [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig*.json',
    'yarn.lock',
    'vitest.config.ts',
    'packages/*/src/shim.{js,mjs}',
    'packages/cli/src/bin.ts',
  ],

  granularity: 'block',
};
