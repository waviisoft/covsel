#!/usr/bin/env node
/**
 * Check covsel's selection for the current diff against the promises that can be
 * checked from outside it.
 *
 * `covsel run` passing tells you the tests it chose to run passed. It does not
 * tell you whether it chose correctly — a selection that quietly ran nothing
 * would also pass, which is the failure this project exists to prevent.
 *
 * What this deliberately does **not** do is re-derive the selection. Block
 * granularity means an entry whose recorded blocks for a changed file were not
 * among the blocks that changed is correctly left out, even though the file is
 * one it covers. Any "expected set" built from covered files alone is therefore
 * wider than the right answer, and asserting on it fails precise selections —
 * measured on this repository, an edit to one narrowly-used function had covsel
 * select 4 of 37 test files, correctly, while a file-level oracle called 17 of
 * them missing. Re-deriving it properly would just be a second copy of
 * `FileSelector`, which proves nothing about the first.
 *
 * So the checks here are the ones that hold whatever the granularity, and that a
 * selector bug cannot satisfy by accident:
 *
 *   - Every selected file is a discovered test file.
 *   - Every changed test file is selected, whatever the map says about it.
 *   - Every `alwaysRun` test file is selected.
 *   - A test the map credits with a changed file but records **no blocks** for
 *     is selected. With no block information there is nothing to narrow by, so
 *     file level is the answer and leaving it out is a skipped test.
 *
 * A full run is a legitimate outcome — a sentinel moved, the config changed, no
 * map yet — so it is reported and accepted rather than failed.
 */
import { appendFileSync } from 'node:fs';

// Imported from the build rather than by package name on purpose: adding
// `@covsel/core` to the root manifest would touch `package.json`, which is a
// sentinel, and every selection in this repository would become a full run --
// including the one this script exists to measure.
import {
  diffChanges,
  discoverTestFiles,
  loadConfig,
  LocalStore,
  matchesAny,
  selectAffected,
} from '../packages/core/dist/index.js';

const cwd = process.cwd();
const config = await loadConfig(cwd);

const map = await new LocalStore({ cwd, dir: config.store.dir }).read();
const discovered = discoverTestFiles(cwd, config);
const result = await selectAffected({ cwd, config });

console.log(
  `map:       ${map ? `${map.entries.length} entries, ${map.granularity}` : 'none'}`,
);
console.log(`suite:     ${discovered.length} test files`);

if (result.fullRun) {
  // Not a failure and not a selection: there is nothing here to be wrong about.
  console.log(`\nvalidate-selection: full run — ${result.reason ?? 'no reason given'}`);
  console.log('Nothing to check: a full run cannot skip a test.');
  process.exit(0);
}

console.log(`selected:  ${result.tests.length} test files`);
for (const t of result.tests) console.log(`             ${t}`);

const selected = new Set(result.tests);
const problems = [];

const unknown = result.tests.filter((t) => !discovered.includes(t));
if (unknown.length > 0) {
  problems.push(`selected files that are not discovered tests: ${unknown.join(', ')}`);
}

const changed = new Set(
  diffChanges(cwd, map?.commit, { exact: true }).map((c) => c.file),
);

// A changed test file runs whatever the map says, so this needs no map at all.
const changedTests = discovered.filter((t) => changed.has(t) && !selected.has(t));
if (changedTests.length > 0) {
  problems.push(`changed test files that were not selected: ${changedTests.join(', ')}`);
}

const alwaysRun = discovered.filter(
  (t) => matchesAny(t, config.alwaysRun) && !selected.has(t),
);
if (alwaysRun.length > 0) {
  problems.push(`alwaysRun test files that were not selected: ${alwaysRun.join(', ')}`);
}

// The file-level safety net: no blocks recorded for a changed file means nothing
// to narrow by, so the entry has to run.
const unnarrowable = new Set();
for (const entry of map?.entries ?? []) {
  for (const covered of entry.files) {
    if (!changed.has(covered.file)) continue;
    const blocks = (entry.blocks ?? []).filter((b) => b.file === covered.file);
    if (blocks.length === 0 && !selected.has(entry.test.file)) {
      unnarrowable.add(`${entry.test.file} (covers ${covered.file}, no blocks recorded)`);
    }
  }
}
if (unnarrowable.size > 0) {
  problems.push(
    `tests the map credits with a changed file and records no blocks for, yet did not select:\n    ${[...unnarrowable].join('\n    ')}`,
  );
}

console.log(
  `\nchanged:   ${changed.size} files since ${(map?.commit ?? 'unknown').slice(0, 12)}`,
);

if (problems.length > 0) {
  console.error('\nvalidate-selection: FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const saved = discovered.length - result.tests.length;
const pct = discovered.length === 0 ? 0 : Math.round((saved / discovered.length) * 100);
console.log(
  `\nvalidate-selection: OK — ran ${result.tests.length} of ${discovered.length} ` +
    `test files, skipping ${saved} (${pct}%), and nothing that had to run was left out.`,
);

// Leave a summary for the job log, when running under GitHub Actions.
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = result.tests.map((t) => `| \`${t}\` |`).join('\n');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## covsel selected ${result.tests.length} of ${discovered.length} test files\n\n` +
      `Skipped ${saved} (${pct}%). Changed files since \`${(map?.commit ?? 'unknown').slice(0, 12)}\`: ${changed.size}.\n\n` +
      `| Selected |\n| --- |\n${rows}\n`,
  );
}
