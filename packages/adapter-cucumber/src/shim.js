// cucumber-js support-code shim. Loaded with cucumber's own `--import`, it wraps
// every scenario with the per-scenario InspectorObserver and writes what each
// scenario executed to COVSEL_OUT on exit. This is the only per-runner code; the
// observer, mapper, and everything downstream are shared.
//
// Hooks must be registered while cucumber is loading support code, so this file
// has to go through cucumber's `--import` (a plain `node --import` preload is
// rejected, because the support-code builder is not running yet). It also has to
// bind to the *user's* cucumber instance rather than a second copy, so the module
// is resolved from the working directory instead of by bare specifier. Shipped as
// plain ESM (not bundled) so those dynamic imports and the top-level await
// survive to runtime.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { InspectorObserver, V8FileMapper } from '@covsel/core';

const cwd = process.cwd();
const outPath = process.env.COVSEL_OUT ?? '';
const config = JSON.parse(process.env.COVSEL_CONFIG ?? '{}');

const require = createRequire(join(cwd, 'package.json'));
const { After, AfterAll, Before, BeforeAll } = await import(
  pathToFileURL(require.resolve('@cucumber/cucumber')).href
);

const observer = new InspectorObserver();
const mapper = new V8FileMapper({
  cwd,
  config: {
    sourceGlobs: config.sourceGlobs ?? ['**/*'],
    testGlobs: config.testGlobs ?? [],
  },
});

const units = [];

BeforeAll(async () => {
  await observer.start();
});

Before(async function (sc) {
  await observer.startTest({ file: sc.gherkinDocument.uri, name: sc.pickle.name });
});

After(async function (sc) {
  const raw = await observer.endTest({
    file: sc.gherkinDocument.uri,
    name: sc.pickle.name,
  });
  const files = await mapper.toFiles(raw);
  units.push({ file: sc.gherkinDocument.uri, name: sc.pickle.name, files });
});

AfterAll(() => {
  if (outPath) writeFileSync(outPath, JSON.stringify(units));
});
