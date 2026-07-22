// Drives the per-test InspectorObserver around two individual tests that share a
// module, and prints the sources each test executed. Run as a plain-node child
// (not through Vitest) so script URLs are the real files. Imports the built core
// by relative path because @covsel/core is not hoisted to the repo root.
import { fileURLToPath } from 'node:url';

import { InspectorObserver, V8FileMapper } from '../../dist/index.js';

const fixtureRoot = fileURLToPath(new URL('./sample/', import.meta.url));

const observer = new InspectorObserver();
await observer.start();

// Import the fixtures after precise coverage is running so calls are counted.
const { alpha } = await import('./sample/src/a.mjs');
const { beta } = await import('./sample/src/b.mjs');

const mapper = new V8FileMapper({
  cwd: fixtureRoot,
  config: { sourceGlobs: ['**/*'], testGlobs: ['**/*.test.*'] },
});

async function observe(name, run) {
  await observer.startTest({ file: 'suite.mjs', name });
  run();
  const raw = await observer.endTest({ file: 'suite.mjs', name });
  const files = await mapper.toFiles(raw);
  return files.map((f) => f.file).sort();
}

const t1 = await observe('alpha', () => alpha(2));
const t2 = await observe('beta', () => beta(2));
await observer.stop();

process.stdout.write(JSON.stringify({ t1, t2 }));
