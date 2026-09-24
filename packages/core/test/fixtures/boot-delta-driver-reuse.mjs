// Drives two separate InspectorObserver instances, one after another, in the
// same process -- the in-process analog of a second recording attaching to a
// server an earlier one already booted. Both share the same globalThis (and
// so the same boot marker) and the same NODE_V8_COVERAGE directory, run as a
// plain-node child so this process is the one under observation. Imports the
// built core by relative path because @covsel/core is not hoisted to the
// repo root.
//
// Checks the raw per-function counts directly rather than going through
// V8FileMapper.toBlocks(): the mapper's own "no data for this range, assume
// it ran" fallback (see boot-delta-coverage.ts's top comment) is a *separate*
// safety net for a script the merge never had a boot shape for at all, and it
// would silently paper over a broken marker here too, crediting neverCalled
// as if it ran and making this test pass either way.
import { InspectorObserver } from '../../dist/index.js';

// Boot: loaded, and its top-level call run, before either observer starts.
const mod = await import('./boot-delta/module.mjs');

function moduleCounts(raw) {
  const script = raw.scripts.find((s) => s.url.includes('module.mjs'));
  const counts = {};
  for (const fn of script?.functions ?? []) {
    counts[fn.functionName] = fn.ranges[0]?.count;
  }
  return counts;
}

// The process's first-ever session: its start() takes the real boot dump
// (module.mjs's top-level bootWork() call already ran) and records the
// marker. Deliberately never stopped -- a reused process keeps running and
// keeps its coverage collection active between recordings, it does not shut
// down between them.
const observer1 = new InspectorObserver();
await observer1.start();
await observer1.startTest({ file: 'suite.mjs', name: 'test1' });
mod.calledInTest1();
const session1 = moduleCounts(
  await observer1.endTest({ file: 'suite.mjs', name: 'test1' }),
);

// A second, independent observer in the same process. Its start() has to
// read observer1's marker back, not trigger a fresh "boot" of its own --
// that would only be a delta since observer1's last dump, and would lose
// neverCalled and bootWork's credit since nothing has touched either again
// since real boot.
const observer2 = new InspectorObserver();
await observer2.start();
await observer2.startTest({ file: 'suite.mjs', name: 'test2' });
mod.calledInTest2();
const session2 = moduleCounts(
  await observer2.endTest({ file: 'suite.mjs', name: 'test2' }),
);

process.stdout.write(JSON.stringify({ session1, session2 }));
