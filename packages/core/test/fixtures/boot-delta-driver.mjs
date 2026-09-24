// Drives InspectorObserver's boot-delta mode: imports a module *before* the
// observer starts (its top-level code is "boot", the way a server's route
// modules run before covsel ever attaches), then attributes two tests' calls
// into it. Run as a plain-node child, with NODE_V8_COVERAGE pointed at a temp
// dir by the caller, so this process is the one under observation. Imports the
// built core by relative path because @covsel/core is not hoisted to the repo
// root.
import { fileURLToPath } from 'node:url';

import { InspectorObserver, V8FileMapper } from '../../dist/index.js';

const fixtureRoot = fileURLToPath(new URL('./boot-delta/', import.meta.url));

// Boot: loaded, and its top-level call run, before any observation starts.
const mod = await import('./boot-delta/module.mjs');

const observer = new InspectorObserver();
await observer.start();

const mapper = new V8FileMapper({
  cwd: fixtureRoot,
  config: { sourceGlobs: ['**/*'], testGlobs: ['**/*.test.*'] },
});

async function observe(name, run) {
  await observer.startTest({ file: 'suite.mjs', name });
  run();
  const raw = await observer.endTest({ file: 'suite.mjs', name });
  const files = await mapper.toFiles(raw);
  const blocks = await mapper.toBlocks(raw);
  return {
    files: files.map((f) => f.file).sort(),
    blockHashes: blocks.map((b) => b.blockHash).sort(),
  };
}

const t1 = await observe('test1', () => mod.calledInTest1());
const t2 = await observe('test2', () => mod.calledInTest2());
await observer.stop();

process.stdout.write(JSON.stringify({ t1, t2 }));
