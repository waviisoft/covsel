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
 *   - Every selected file is a discovered test file. This one fails today when a
 *     pull request deletes a test file and changes a source that test covered:
 *     the map entry outlives the file and the selection still names it. That is
 *     covsel/covsel#72, a defect in the selector rather than in this check --
 *     worth knowing before debugging the harness.
 *   - Every changed test file is selected, whatever the map says about it.
 *   - Every `alwaysRun` test file is selected.
 *   - Every test whose entry credits **no source at all** is selected. Nothing
 *     in a diff can match an empty file list, so an entry like that is unknown
 *     coverage rather than a measurement, and reading it the other way skips the
 *     test on every run there will ever be.
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
// The project's config as written, without an adapter resolved over it. Equal to
// what `covsel run` uses here because this repository sets `testGlobs`; a project
// leaning on an adapter's `defaultTestGlobs` would need `resolveConfigFor`, or
// this would measure a different suite than the selector it is checking.
const config = await loadConfig(cwd);

const map = await new LocalStore({ cwd, dir: config.store.dir }).read();
const discovered = discoverTestFiles(cwd, config);
const result = await selectAffected({ cwd, config });

console.log(
  `map:       ${map ? `${map.entries.length} entries, ${map.granularity}` : 'none'}`,
);
console.log(`suite:     ${discovered.length} test files`);

if (result.fullRun) {
  // Not a failure and not a selection: a full run cannot skip a test, so there
  // is no choice here to be wrong about. Sentinels move often -- a dependency
  // bump is enough -- so this branch is where the check spends much of its life,
  // and exiting on it silently would mean saying nothing at all on those runs.
  // So it asserts the one thing left: that a run calling itself full really is.
  // `selectAffected` builds a full run from the same discovery this script does,
  // which makes it hold by construction today; it is here to notice if that ever
  // stops being true, since a "full run" quietly short of the suite is the one
  // failure this branch would otherwise hide.
  console.log(`\nvalidate-selection: full run — ${result.reason ?? 'no reason given'}`);
  const missing = discovered.filter((t) => !result.tests.includes(t));
  if (missing.length > 0) {
    console.error('\nvalidate-selection: FAILED');
    console.error(
      `  - a full run left out ${missing.length} discovered test files:\n    ${missing.join('\n    ')}`,
    );
    process.exit(1);
  }
  console.log(`All ${discovered.length} discovered test files will run.`);
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

// `map` is non-null from here: an absent map forces a full run, which exited above.
const changed = new Set(diffChanges(cwd, map.commit, { exact: true }).map((c) => c.file));

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

// The recorder saw nothing this test executed, so there is no coverage here to
// select on -- only an entry shaped like a measurement.
//
// Asked with `alwaysRun` emptied, because on this repository the two sets are
// the same three files: the project lists its child-process tests there as
// well, so checking the selection as configured would pass on the strength of
// the belt while the rule itself was broken. This asks the selector the
// question with the belt removed, which is the only form of it that can fail.
const unmeasured = new Set(
  map.entries.filter((e) => e.files.length === 0).map((e) => e.test.file),
);
if (unmeasured.size > 0) {
  const bare = await selectAffected({ cwd, config: { ...config, alwaysRun: [] } });
  // A full run there selects everything and settles nothing, which is not a
  // failure -- it is the same accepted outcome as a full run of the real
  // selection, and saying so beats a silent skip.
  if (bare.fullRun) {
    console.log(
      `\nunmeasured: ${unmeasured.size} entry(ies) cover no source; not checkable ` +
        `on this diff (the selection without alwaysRun is a full run)`,
    );
  } else {
    const bareSelected = new Set(bare.tests);
    const missing = discovered.filter((t) => unmeasured.has(t) && !bareSelected.has(t));
    if (missing.length > 0) {
      problems.push(
        `tests whose entry covers no source, yet were not selected on their own ` +
          `merit (alwaysRun aside): ${missing.join(', ')}`,
      );
    }
  }
}

// The file-level safety net: no blocks recorded for a changed file means nothing
// to narrow by, so the entry has to run.
const unnarrowable = new Set();
for (const entry of map.entries) {
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

const base = (map.commit ?? 'unknown').slice(0, 12);
console.log(`\nchanged:   ${changed.size} files since ${base}`);

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
  // A table with no rows renders as stray pipes, so an empty selection -- legal,
  // if nothing changed and the project sets no `alwaysRun` -- says so in prose.
  const table =
    result.tests.length === 0
      ? '_Nothing selected: no test covers what changed._\n'
      : `| Selected |\n| --- |\n${result.tests.map((t) => `| \`${t}\` |`).join('\n')}\n`;
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## covsel selected ${result.tests.length} of ${discovered.length} test files\n\n` +
      `Skipped ${saved} (${pct}%). Changed files since \`${base}\`: ${changed.size}.\n\n` +
      table,
  );
}
