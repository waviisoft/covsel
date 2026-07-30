// Mocha root hook plugin. Loaded with Mocha's own `--require`, it wraps every
// test with the per-test InspectorObserver so each test's executed sources are
// recorded individually, then writes them to COVSEL_OUT on exit. The recorder
// passes the spec file, output path, and config through the environment. This is
// the only per-runner code; the observer, mapper, and everything downstream are
// shared. Shipped as plain ESM (not bundled) so the `node:` import prefixes
// survive to runtime.
//
// A root hook plugin rather than plain `--require`d hooks, because only the
// plugin form registers hooks Mocha itself owns: the root `beforeEach` is the
// first hook to run before a test and the root `afterEach` the last to run
// after it, so the window encloses the test and every hook it depends on, and
// nothing between two tests belongs to either. Its `.mjs` extension is what
// makes Mocha import it rather than require it, on any Node version.
import { writeFileSync } from 'node:fs';

import { InspectorObserver, V8FileMapper } from '@covsel/core';

// Per-test observation is at source-file granularity: V8 precise coverage omits
// un-run functions from the delta, so it reliably identifies which *files* a
// test executed but not which un-run functions to exclude on a shared file.
// Blocks are therefore left to the whole-file recorders.
const file = process.env.COVSEL_TEST_FILE ?? '';
const outPath = process.env.COVSEL_OUT ?? '';
const config = JSON.parse(process.env.COVSEL_CONFIG ?? '{}');

const observer = new InspectorObserver();
// COVSEL_CONFIG is the mapper's own configuration, carried whole. Defaults here
// cover only a missing variable: a project's `sourceMaps` settings arrive as
// given, because a mapper that quietly lost them would fail every recording
// against a build the project had already accepted.
const mapper = new V8FileMapper({
  cwd: process.cwd(),
  config: {
    ...config,
    sourceGlobs: config.sourceGlobs ?? ['**/*'],
    testGlobs: config.testGlobs ?? [],
  },
});

const units = [];

/**
 * The title `--grep` is matched against: a test's own title preceded by the
 * titles of every suite around it. Recording the leaf title instead would name
 * a test the run filter could not find.
 */
const titleOf = (test) => test.fullTitle();

export const mochaHooks = {
  async beforeAll() {
    await observer.start();
  },
  async beforeEach() {
    await observer.startTest({ file, name: titleOf(this.currentTest) });
  },
  async afterEach() {
    const name = titleOf(this.currentTest);
    const raw = await observer.endTest({ file, name });
    const files = await mapper.toFiles(raw);
    units.push({ name, files });
  },
};

process.on('exit', () => {
  // The scripts the mapper let through unmapped travel back with the units:
  // each is coverage this recording is missing, and the recorder is what tells
  // the user so.
  if (outPath) {
    writeFileSync(
      outPath,
      JSON.stringify({ units, allowedUnmappable: mapper.takeAllowedUnmappable() }),
    );
  }
});
