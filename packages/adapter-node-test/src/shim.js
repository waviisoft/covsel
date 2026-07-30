// node:test preload shim. Loaded with `node --import`, it wraps every test with
// the per-test InspectorObserver so each test's executed sources and blocks are
// recorded individually, then writes them to COVSEL_OUT on exit. The recorder
// passes the test file, output path, and config through the environment. This is
// the only per-runner code; the observer, mapper, and everything downstream are
// shared. Shipped as plain ESM (not bundled) so the `node:` import prefixes and
// top-level await survive to runtime.
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach } from 'node:test';

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

await observer.start();

beforeEach(async (t) => {
  await observer.startTest({ file, name: t.name });
});

afterEach(async (t) => {
  const raw = await observer.endTest({ file, name: t.name });
  const files = await mapper.toFiles(raw);
  units.push({ name: t.name, files });
});

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
