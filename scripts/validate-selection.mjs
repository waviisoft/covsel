#!/usr/bin/env node
/**
 * Prove that covsel's selection for the current diff is both narrow and sound.
 *
 * `covsel run` passing tells you the tests it chose to run passed. It does not
 * tell you whether it chose correctly — a selection that quietly ran nothing
 * would also pass, which is the failure this project exists to prevent. So this
 * checks the selection against the two things that can be checked without
 * running anything:
 *
 *   Narrow — it selected fewer tests than the suite holds, and every one of them
 *   is a real discovered test file. A "selection" that is the whole suite is a
 *   full run wearing a disguise, and one naming a file that does not exist is a
 *   bug in formatting.
 *
 *   Sound — every test the map itself says covers a changed file was selected.
 *   This recomputes the expected set from the map and the diff, at file
 *   granularity, without going through the selector. Block granularity can only
 *   ever select a subset of what file granularity would, so anything missing
 *   here is a test covsel should have run and did not.
 *
 * Exits non-zero with the discrepancy when either fails.
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
  selectAffected,
} from '../packages/core/dist/index.js';

const cwd = process.cwd();
const config = await loadConfig(cwd);

const map = await new LocalStore({ cwd, dir: config.store.dir }).read();
if (map === undefined) {
  console.error('validate-selection: no usable map — fetch or record one first');
  process.exit(1);
}

const discovered = discoverTestFiles(cwd, config);
const result = await selectAffected({ cwd, config });

console.log(`map:       ${map.entries.length} entries, granularity ${map.granularity}`);
console.log(`commit:    ${map.commit ?? 'none'}`);
console.log(`suite:     ${discovered.length} test files`);

if (result.fullRun) {
  console.error(`\nvalidate-selection: FAILED — this was a full run (${result.reason})`);
  console.error('A full run proves nothing about selection. Expected a narrowed set.');
  process.exit(1);
}

console.log(`selected:  ${result.tests.length} test files`);
for (const t of result.tests) console.log(`             ${t}`);

const problems = [];

// Narrow.
if (result.tests.length >= discovered.length) {
  problems.push(
    `selected ${result.tests.length} of ${discovered.length} tests — that is the whole suite`,
  );
}
const unknown = result.tests.filter((t) => !discovered.includes(t));
if (unknown.length > 0) {
  problems.push(`selected files that are not discovered tests: ${unknown.join(', ')}`);
}

// Sound. Recompute what the map says, independently of the selector.
const changed = new Set(diffChanges(cwd, map.commit, { exact: true }).map((c) => c.file));
const expected = new Set();
for (const entry of map.entries) {
  if (entry.files.some((f) => changed.has(f.file))) expected.add(entry.test.file);
}
// A changed test file always runs, whatever the map says about it.
for (const file of changed) if (discovered.includes(file)) expected.add(file);

const missing = [...expected].filter((t) => !result.tests.includes(t)).sort();
if (missing.length > 0) {
  problems.push(
    `the map says these cover a changed file but they were not selected:\n    ${missing.join('\n    ')}`,
  );
}

console.log(
  `\nchanged:   ${changed.size} files since ${(map.commit ?? '').slice(0, 12)}`,
);
console.log(`expected:  ${expected.size} tests cover them, by the map alone`);

if (problems.length > 0) {
  console.error('\nvalidate-selection: FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const saved = discovered.length - result.tests.length;
const pct = Math.round((saved / discovered.length) * 100);
console.log(
  `\nvalidate-selection: OK — ran ${result.tests.length} of ${discovered.length} ` +
    `test files, skipping ${saved} (${pct}%), and every test the map implicates was selected.`,
);

// Leave a summary for the job log, when running under GitHub Actions.
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = result.tests.map((t) => `| \`${t}\` |`).join('\n');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## covsel selected ${result.tests.length} of ${discovered.length} test files\n\n` +
      `Skipped ${saved} (${pct}%). Changed files since \`${(map.commit ?? '').slice(0, 12)}\`: ${changed.size}.\n\n` +
      `| Selected |\n| --- |\n${rows}\n`,
  );
}
