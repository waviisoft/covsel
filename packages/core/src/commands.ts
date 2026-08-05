import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { blockHashesOf, extractBlocks } from './blocks.js';
import { agreedScope } from './combine.js';
import {
  CONFIG_FILES,
  type CovselConfig,
  type CovselConfigInput,
  recordedConfig,
  resolveConfig,
} from './config.js';
import { dependencyChange } from './dependencies.js';
import { discoverTestFiles, isTestFile } from './discover.js';
import {
  commitExists,
  diffChanges,
  gitHeadCommit,
  isDirtyWorkTree,
  isGitWorkTree,
} from './git.js';
import { readInstalledInventory } from './inventory.js';
import type {
  Adapter,
  Change,
  Recorder,
  RecordedUnit,
  SelectionRunInit,
} from './interfaces.js';
import { makeMatcher, makeStrictMatcher, matchesAny } from './match.js';
import { type MapperConfig, V8FileMapper } from './mapper.js';
import { ProcessObserver } from './observer.js';
import { hashFileContents, isExcludedRel, toRepoRelative, walkFiles } from './paths.js';
import { FailOpenPolicy, fullRunReason } from './policy.js';
import {
  type CoverageMap,
  type Granularity,
  isUsableMap,
  MAP_SCHEMA_VERSION,
  type MapEntry,
  OBSERVES_EVERYTHING,
  type TestId,
} from './schema.js';
import { FileSelector } from './selector.js';
import { LocalStore, type StoredMap } from './store.js';

export interface GenericRecorderInit {
  command: string[];
  cwd: string;
  config: MapperConfig & Pick<CovselConfig, 'granularity'>;
  env?: NodeJS.ProcessEnv;
  /**
   * The caller's assertion that this command executes everything under test
   * inside the Node process tree covsel starts, so the coverage dump holds every
   * script the run loaded.
   *
   * It is what makes `observesPackages` sound, and it is not something this
   * recorder can establish. A command arrives here as an argv somebody typed,
   * and one that drives a browser, shells out to another runtime, or runs its
   * tests in a container looks exactly like one that does not. Set it only when
   * you know this run: a caller that wrote the command, and knows the suite it
   * names executes nothing outside that tree.
   *
   * It is never a blanket answer for a runner. The claim is about where the code
   * under test runs, not about how the runner loads it — a runner that executes
   * its own sources directly can still be pointed at a spec that drives a
   * browser, and an adapter vouching for every project that uses it would make
   * the same guess this input exists to refuse.
   *
   * Left unset, entries carry no packages and the map no inventory, so the
   * recording holds no opinion about dependencies and a change to one is left to
   * the lockfile sentinel, which the default `sentinels` cover for every package
   * manager covsel recognises.
   *
   * It does not widen `observes`, which is `**` either way: what an unvouched
   * command hides is a process boundary, and a repo-path scope cannot describe
   * one.
   */
  runsInNodeProcessTree?: boolean;
}

/** The whole-file recorder: ProcessObserver (NODE_V8_COVERAGE) piped into the V8 mapper. */
export function createGenericRecorder(init: GenericRecorderInit): Recorder {
  const observer = new ProcessObserver({
    command: init.command,
    cwd: init.cwd,
    ...(init.env ? { env: init.env } : {}),
  });
  const mapper = new V8FileMapper({ cwd: init.cwd, config: init.config });
  const wantBlocks = init.config.granularity !== 'file';
  // Only the caller can answer whether the command runs everything under test in
  // the tree covsel spawns, so only the caller's answer is used.
  const observesPackages = init.runsInNodeProcessTree === true;
  return {
    // Bounded by that same process tree. NODE_V8_COVERAGE is inherited by child
    // processes and dumps every script they load, so anything the run executes
    // in the tree is visible to this recorder wherever it lives in the repo. A
    // command that executes code outside it — a browser, another runtime — is
    // not, and no scope can say so: globs name where in the repo a path is,
    // never which process ran it.
    observes: OBSERVES_EVERYTHING,
    // The same dump is what makes packages visible: it holds every script the
    // process tree loaded, vendored code included, before any coverage provider
    // has had the chance to filter `node_modules` out of it. But only for what
    // ran in that tree, and this recorder is handed a command rather than
    // knowing one. Reading the claim off the command name would be a guess
    // dressed as evidence, and reading it off the dump could only ever refute
    // it — vendored code in the dump is equally consistent with having missed
    // every package that ran somewhere else. So the claim belongs to whoever
    // chose the command, and is absent until they make it.
    ...(observesPackages ? { observesPackages: true } : {}),
    async record(testFile: string) {
      await observer.startTest({ file: testFile });
      const raw = await observer.endTest({ file: testFile });
      const files = await mapper.toFiles(raw);
      const blocks = wantBlocks ? await mapper.toBlocks(raw) : [];
      return [
        {
          test: { file: testFile },
          files,
          blocks,
          // Attributed exactly when it is claimed. A list nobody stands behind
          // is dropped by recording anyway, and a unit carrying one while its
          // recorder is silent contradicts what a unit's packages mean.
          ...(observesPackages ? { packages: await mapper.toPackages(raw) } : {}),
        },
      ];
    },
    unmappableAllowed: () => mapper.takeAllowedUnmappable(),
  };
}

/**
 * True when an entry's recording measured nothing — it credits no source file.
 *
 * Read off `files` alone, because that is what selection matches a diff
 * against: blocks only refine a file that already matched, so an entry with
 * blocks and no files is just as unselectable as one with neither. The question
 * this answers is not "did the test do anything" but "can any change to this
 * repository ever select it", and for an entry crediting no file the answer is
 * no, whatever else the entry carries.
 *
 * Takes anything holding a file list so that recording, status and selection
 * ask the question in one place: a unit reported as measuring nothing is
 * exactly the entry selection will later have to run unconditionally.
 */
export function measuredNothing(entry: Pick<MapEntry, 'files'>): boolean {
  return entry.files.length === 0;
}

/**
 * What to say when discovery found no test files. Names both halves of the
 * question — the globs and where they were matched — because the answer is almost
 * always that the project's layout is not the one the globs describe, and
 * `test/*.js` rather than `*.test.js` is common enough to be the first guess.
 */
function noTestFilesFound(cwd: string, config: Pick<CovselConfig, 'testGlobs'>): string {
  return (
    `no test files matched ${config.testGlobs.join(', ')} under ${cwd} ` +
    `-- set testGlobs to your project's layout (e.g. 'test/**/*.js')`
  );
}

/** Hash every existing sentinel file, keyed by repo-relative path. */
function hashSentinels(cwd: string, sentinels: string[]): Record<string, string> {
  const isSentinel = makeMatcher(sentinels);
  const hashes: Record<string, string> = {};
  for (const rel of walkFiles(cwd)) {
    if (isSentinel(rel)) hashes[rel] = hashFileContents(`${cwd}/${rel}`);
  }
  return hashes;
}

function assembleMap(
  entries: MapEntry[],
  cwd: string,
  config: CovselConfig,
  recordedAt: string,
  observed: readonly string[],
  dirty: boolean,
  observesPackages: boolean,
): CoverageMap {
  // A commit is a claim that this map describes that commit's tree, and selection
  // treats it as exact. Recording from an edited tree describes a state no commit
  // names: return the tree to HEAD and the diff from the stamped commit is empty,
  // so the map is fully trusted for a tree it never described, and coverage the
  // edited tree did not execute is missing from a map that looks healthy. An
  // unanchored map falls open instead, which costs full runs until the next
  // recording and cannot skip a test.
  const commit = dirty ? undefined : gitHeadCommit(cwd);
  // Reflect what was actually recorded: per-test (node:test) recorders capture
  // no blocks, so the map is file-granular even when config asks for block.
  const hasBlocks = entries.some((e) => (e.blocks?.length ?? 0) > 0);
  const granularity: Granularity =
    config.granularity !== 'file' && hasBlocks ? 'block' : 'file';
  // Both halves are required, and each is useless without the other. Entries
  // say which packages ran; the inventory says which packages were there to
  // run, which is what tells "installed and never executed" apart from "not
  // installed at the time, so the map has no opinion". A recorder that cannot
  // see packages, or a package manager that leaves no proof its tree is
  // current, leaves this absent and every dependency change falls open.
  const dependencies = observesPackages ? readInstalledInventory(cwd) : undefined;
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity,
    ...(commit ? { commit } : {}),
    recordedAt,
    sentinelHashes: hashSentinels(cwd, config.sentinels),
    // What the entries below mean, stated rather than left to be inferred from a
    // later diff: a selection made under different values is reading the map for
    // something it never measured.
    config: recordedConfig(config),
    observed: [...observed],
    ...(dependencies ? { dependencies } : {}),
    entries,
  };
}

export interface RecordEvent {
  kind: 'recorded' | 'failed';
  file: string;
  /** Number of test units recorded from this file (per-test recorders yield many). */
  tests?: number;
  sources?: number;
  /**
   * Units recorded from this file that credit no source at all. Present only
   * when there were any: each is a test selection can say nothing about, so it
   * will run on every selection until the recorder can see what it executes.
   */
  unmeasured?: number;
  reason?: string;
  /**
   * Scripts this file executed that could not be mapped back to any source and
   * were accepted under `sourceMaps.allowUnmappable`. Present only when there
   * were any: each is a gap in what the entry credits.
   */
  allowedUnmappable?: string[];
}

export interface RecordResult {
  ok: boolean;
  recorded: number;
  failures: { file: string; reason: string }[];
  mapPath: string;
  testFiles: string[];
  map?: CoverageMap;
  /**
   * True when the map was recorded from a tree with uncommitted changes, and so
   * records no commit. Selection falls open until a map recorded from a committed
   * tree replaces it — correct, and worth saying out loud when the map is written
   * rather than only when selection later declines to narrow.
   */
  unanchored?: boolean;
  /**
   * Units whose entry credits no source, across the whole recording. Present
   * only when there were any.
   *
   * Recording them is not an error — a test that only asserts on constants
   * legitimately covers nothing, and refusing the map would leave the project
   * with none at all over something selection can handle safely. But a test
   * covsel cannot narrow on is worth saying out loud at the moment it is
   * recorded, because the usual cause is a recorder that could not watch where
   * the test ran, and the fix for that is a different adapter or a different
   * test, not a re-recording.
   */
  unmeasured?: TestId[];
  /**
   * Why recording failed as a whole, as opposed to per test file. Present only
   * for a failure that belongs to the run rather than to anything in it — today,
   * discovering no test files at all.
   */
  error?: string;
}

export interface RecordInit {
  cwd: string;
  config: CovselConfig;
  recorder: Recorder;
  /** ISO timestamp to stamp on the map (defaults to now). */
  recordedAt?: string;
  onEvent?: (event: RecordEvent) => void;
}

/**
 * The globs a unit claims to have been observed within that its recorder does
 * not declare.
 *
 * A unit combined from several windows may narrow the recorder's declaration —
 * it says which of them actually watched this entry — but it may never widen it.
 * The declaration is the claim the adapter stands behind; a unit reporting more
 * than that is a contradiction between the two, and the direction it resolves
 * decides whether a change outside the declaration falls open or is read as a
 * measurement. Believing the wider claim skips tests, so it is refused.
 *
 * Globs are compared as written. Deciding whether one glob's paths all fall
 * inside another's is not something picomatch can answer, and guessing "covered"
 * is the guess that lets an over-claim through. `**` is the one exception, since
 * it matches every path by definition and nothing can exceed it.
 */
function overclaimedGlobs(
  unit: RecordedUnit,
  declared: readonly string[],
): readonly string[] {
  if (unit.observes === undefined || declared.includes('**')) return [];
  const allowed = new Set(declared);
  return unit.observes.filter((glob) => !allowed.has(glob));
}

/**
 * Why a unit's package list contradicts its recorder's declaration, if it does.
 *
 * Only one direction is fatal, and it is the one where absence would be read as
 * a measurement: a recorder declaring `observesPackages` whose unit says nothing
 * about packages. Written as it stands, that entry reads as a test running no
 * vendored code, and every dependency it really uses goes unselected on a bump.
 * There is no safe way to guess what it ran, so the recording fails and says so.
 *
 * The opposite -- a unit reporting packages its recorder has not claimed to
 * watch -- is a claim nobody stood behind, but it costs nothing to decline. The
 * packages are dropped and the map keeps none, which is exactly today's
 * behaviour. Failing there would break every recorder that wraps another and
 * forwards its units while declaring its own narrower scope, which is the
 * ordinary way to build one, and would leave the project with no map at all
 * over a field nothing selects on yet.
 */
function packageClaimMismatch(
  unit: RecordedUnit,
  observesPackages: boolean,
): string | undefined {
  if (observesPackages && unit.packages === undefined) {
    return 'recorded no package list, though the recorder declares it observes packages';
  }
  return undefined;
}

/** What a report belongs to when it belongs to the run rather than to one file. */
const THE_RUN = '(the run)';

/**
 * Drive a recorder that records the whole suite in one invocation, and reconcile
 * what came back against what was asked for.
 *
 * The reconciliation is the point. Driven file by file, a file that yields
 * nothing is visibly a shortfall because covsel named it; here the run reports
 * whatever it reports, and a test file missing from that report would otherwise
 * be written as silence — which selection reads as "covers nothing", and so
 * never runs. A file the run never mentioned is therefore a failure against that
 * file. Nothing is asserted about tests *within* a file, since covsel does not
 * know how many a file holds; that is the recorder's own contract with its
 * runner.
 */
async function recordWholeRun(init: {
  recorder: Recorder;
  recordRun: (testFiles: readonly string[]) => Promise<RecordedUnit[]>;
  testFiles: readonly string[];
  ingest: (units: readonly RecordedUnit[]) => { sources: number; blind: number };
  onEvent?: (event: RecordEvent) => void;
}): Promise<{ failures: { file: string; reason: string }[]; error?: string }> {
  const { recorder, recordRun, testFiles, ingest, onEvent } = init;
  const byFile = new Map<string, RecordedUnit[]>();
  try {
    const units = await recordRun(testFiles);
    // Grouped inside the `try`, so a recorder that resolves to something that is
    // not a list of units is reported the way the per-file path reports it,
    // rather than escaping `recordMap` as an unhandled rejection that loses
    // every message covsel would otherwise print.
    for (const unit of units) {
      const list = byFile.get(unit.test.file);
      if (list === undefined) byFile.set(unit.test.file, [unit]);
      else list.push(unit);
    }
  } catch (err) {
    // The suite is one unit of success: a run that died partway leaves coverage
    // for the tests it reached, and nothing afterwards can tell that apart from
    // a complete recording.
    const reason = err instanceof Error ? err.message : String(err);
    recorder.unmappableAllowed?.();
    onEvent?.({ kind: 'failed', file: THE_RUN, reason });
    return { failures: [], error: reason };
  }

  const failures: { file: string; reason: string }[] = [];
  // Reported against the run rather than against each file. One invocation
  // covered the whole suite, so what it let through unmapped belongs to the run;
  // attaching the list to every file's event would name a script that all but
  // one of them never executed.
  const allowed = recorder.unmappableAllowed?.() ?? [];
  if (allowed.length > 0) {
    onEvent?.({
      kind: 'recorded',
      file: THE_RUN,
      tests: 0,
      sources: 0,
      allowedUnmappable: allowed,
    });
  }
  // Every file covsel discovered, in its order, so the report reads the same as
  // the per-file path's regardless of what order the run reported in.
  for (const file of testFiles) {
    const forFile = byFile.get(file);
    if (forFile === undefined) {
      const reason =
        'the run reported no coverage for it. A test file the run never ' +
        'mentions cannot be told apart from one that covers nothing, and ' +
        'covering nothing means never being selected again.';
      failures.push({ file, reason });
      onEvent?.({ kind: 'failed', file, reason });
      continue;
    }
    try {
      const { sources, blind } = ingest(forFile);
      onEvent?.({
        kind: 'recorded',
        file,
        tests: forFile.length,
        sources,
        ...(blind > 0 ? { unmeasured: blind } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ file, reason });
      onEvent?.({ kind: 'failed', file, reason });
    }
  }

  // Units for files covsel never discovered are kept rather than refused: the
  // recorder saw the runner execute them, and an entry selection never consults
  // costs nothing, while refusing would fail a recording over a disagreement
  // about discovery that the user may have configured deliberately.
  for (const [file, forFile] of byFile) {
    if (testFiles.includes(file)) continue;
    try {
      ingest(forFile);
    } catch (err) {
      failures.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { failures };
}

/**
 * Record a fresh map. Drives the recorder over every discovered test file —
 * one invocation per file, or one invocation for the whole suite when the
 * recorder records that way. If any file fails to record (e.g. a failing test
 * invalidates its coverage), the map is *not* written — a partial map cannot be
 * trusted for selection.
 */
export async function recordMap(init: RecordInit): Promise<RecordResult> {
  const { cwd, config, recorder } = init;
  const testFiles = discoverTestFiles(cwd, config);
  const store = new LocalStore({ cwd, dir: config.store.dir });

  // Nothing to record is a failure, not an empty success. A map with no entries
  // is syntactically valid and measures nothing, and writing one turns a
  // mismatched `testGlobs` into a green CI run that executed no tests at all.
  // There is no repository for which an empty map is the right answer. Checked
  // before the tree is sampled, since there is nothing to sample it for.
  if (testFiles.length === 0) {
    return {
      ok: false,
      recorded: 0,
      failures: [],
      mapPath: store.path(),
      testFiles,
      error: noTestFilesFound(cwd, config),
    };
  }

  // Sampled before a single test runs, because this asks what tree the recording
  // was taken against — and that is the tree as it stood when the suite started.
  // Asking afterwards would answer a different question and get it wrong in a
  // common case: a suite that writes anything untracked inside the repository,
  // such as a snapshot created on first run, leaves the tree dirty by the end,
  // and the map would never be anchored for as long as that suite exists.
  const dirty = isDirtyWorkTree(cwd);
  const entries: MapEntry[] = [];
  const failures: { file: string; reason: string }[] = [];
  const scopes: (readonly string[])[] = [];
  const unmeasured: TestId[] = [];

  const wantBlocks = config.granularity !== 'file';
  const observesPackages = recorder.observesPackages === true;

  /**
   * Check a run's units and turn them into entries, returning how many sources
   * they credited. Shared by both recording modes so neither can be held to a
   * weaker rule than the other. Throws on the first unit that breaks one.
   */
  const ingest = (units: readonly RecordedUnit[]): { sources: number; blind: number } => {
    for (const unit of units) {
      const overclaimed = overclaimedGlobs(unit, recorder.observes);
      if (overclaimed.length > 0) {
        throw new Error(
          `recorded as observing ${overclaimed.join(', ')}, which the recorder ` +
            `does not declare (it declares ${[...recorder.observes].join(', ') || 'nothing'})`,
        );
      }
      const mismatch = packageClaimMismatch(unit, observesPackages);
      if (mismatch !== undefined) throw new Error(mismatch);
    }
    let sources = 0;
    let blind = 0;
    for (const unit of units) {
      entries.push({
        test: unit.test,
        files: unit.files,
        ...(wantBlocks && unit.blocks.length > 0 ? { blocks: unit.blocks } : {}),
        // Kept only when the recorder stands behind it: a list from one that
        // does not is declined rather than trusted. `!== undefined` rather
        // than truthiness, because `[]` is the measurement "ran no vendored
        // code" and turning that into silence is what skips tests.
        ...(observesPackages && unit.packages !== undefined
          ? { packages: unit.packages }
          : {}),
      });
      // A unit combined from several observation windows knows the scope those
      // windows add up to, which is what its entry was really watched for; a
      // unit from a single window is covered by the recorder's declaration.
      scopes.push(unit.observes ?? recorder.observes);
      sources += unit.files.length;
      if (measuredNothing(unit)) {
        blind += 1;
        unmeasured.push(unit.test);
      }
    }
    return { sources, blind };
  };

  if (typeof recorder.recordRun === 'function') {
    const outcome = await recordWholeRun({
      recorder,
      recordRun: recorder.recordRun.bind(recorder),
      testFiles,
      ingest,
      ...(init.onEvent ? { onEvent: init.onEvent } : {}),
    });
    if (outcome.error !== undefined) {
      return {
        ok: false,
        recorded: entries.length,
        failures: outcome.failures,
        mapPath: store.path(),
        testFiles,
        error: outcome.error,
      };
    }
    failures.push(...outcome.failures);
  } else if (typeof recorder.record !== 'function') {
    return {
      ok: false,
      recorded: 0,
      failures: [],
      mapPath: store.path(),
      testFiles,
      error:
        'the adapter’s recorder implements neither `record` nor `recordRun`, so ' +
        'there is no way to observe a test. This is an adapter bug; report it to ' +
        'whoever publishes it.',
    };
  } else {
    for (const file of testFiles) {
      try {
        const units = await recorder.record(file);
        const { sources, blind } = ingest(units);
        const allowed = recorder.unmappableAllowed?.() ?? [];
        init.onEvent?.({
          kind: 'recorded',
          file,
          tests: units.length,
          sources,
          ...(blind > 0 ? { unmeasured: blind } : {}),
          ...(allowed.length > 0 ? { allowedUnmappable: allowed } : {}),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({ file, reason });
        // Drop whatever this file let through unmapped before moving on. A
        // recorder that accumulates across files (the generic one does, in its
        // mapper) would otherwise carry it to the next file's event, naming a
        // script that file never executed.
        recorder.unmappableAllowed?.();
        init.onEvent?.({ kind: 'failed', file, reason });
      }
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      recorded: entries.length,
      failures,
      mapPath: store.path(),
      testFiles,
    };
  }

  const recordedAt = init.recordedAt ?? new Date().toISOString();
  // The map claims one scope for every entry in it, so it may claim no more than
  // the units agreed on: an entry watched by a narrower set of windows than
  // another must not be selected against paths its own windows never saw. Units
  // can only narrow — anything wider than the recorder's declaration already
  // failed the recording above. With a single-window recorder every unit reports
  // that declaration, so this is it.
  const observed = entries.length > 0 ? agreedScope(scopes) : recorder.observes;
  const map = assembleMap(
    entries,
    cwd,
    config,
    recordedAt,
    observed,
    dirty,
    observesPackages,
  );
  await store.write(map);
  return {
    ok: true,
    recorded: entries.length,
    failures: [],
    mapPath: store.path(),
    testFiles,
    map,
    ...(unmeasured.length > 0 ? { unmeasured } : {}),
    // Keyed on the dirty tree specifically, not on the absence of a commit. A
    // repository with no commits yet also has no commit to stamp, and telling
    // someone their uncommitted changes caused it would be a lie.
    ...(dirty && isGitWorkTree(cwd) ? { unanchored: true } : {}),
  };
}

/**
 * Attach `changedBlockHashes` to each change to a file the map recorded blocks
 * for: the recorded block hashes that are no longer present in the current file.
 * A test is then affected only if a block it actually executed changed. Files we
 * cannot read or parse are left unannotated (undefined), which the selector
 * treats as a file-level change — fail-open.
 */
function annotateChangedBlocks(cwd: string, changes: Change[], map: CoverageMap): void {
  const recordedByFile = new Map<string, Set<string>>();
  for (const entry of map.entries) {
    for (const block of entry.blocks ?? []) {
      let set = recordedByFile.get(block.file);
      if (!set) recordedByFile.set(block.file, (set = new Set()));
      set.add(block.blockHash);
    }
  }
  for (const change of changes) {
    const recorded = recordedByFile.get(change.file);
    if (!recorded) continue;
    let current: Set<string>;
    try {
      current = blockHashesOf(readFileSync(join(cwd, change.file), 'utf8'), change.file);
    } catch {
      continue; // unreadable/deleted → leave undefined → file-level
    }
    change.changedBlockHashes = [...recorded].filter((h) => !current.has(h));
  }
}

export interface AffectedResult {
  fullRun: boolean;
  /** Present when `fullRun` is true: why every test was selected. */
  reason?: string;
  /**
   * Selected test files, repo-relative, sorted, deduplicated.
   *
   * Empty alongside `fullRun: true` when discovery itself found nothing — there
   * is no list to give, and the runner is handed its own command unfiltered so
   * its own discovery applies. `fullRun` is the field to branch on; an empty
   * `tests` never means "run nothing".
   */
  tests: string[];
  /**
   * The selected test units, sorted by file and then by name. A unit with a
   * `name` is an individual test (per-test granularity); a unit without one
   * means the whole file. Adapters use these to format runner-native, per-test
   * selection; collapsing them to their files yields exactly `tests`.
   */
  selected: TestId[];
}

export interface SelectInit {
  cwd: string;
  config: CovselConfig;
  since?: string;
}

type DiffBase =
  | { kind: 'base'; since?: string; exact?: boolean }
  | { kind: 'untrusted'; reason: string };

/**
 * Decide what to diff against. A map describes the repository as it was at the
 * commit it was recorded on, so that commit — not the merge-base with the
 * default branch — is the honest starting point: anything changed since then is
 * outside what the map knows. This matters most in CI, where a map published on
 * the default branch is restored onto a later commit; diffing only from the
 * merge-base would silently ignore everything committed in between.
 *
 * The comparison against that commit is exact — its tree against what is on disk
 * now — rather than routed through a merge-base. A merge-base only answers
 * "where did these branches part", which hides every file the recorded commit
 * carries that HEAD's history does not: checking out an older commit, resetting
 * history back, or restoring a map published on a branch tip onto a commit that
 * branched earlier would all leave the map describing code that is not there.
 *
 * An explicit `--since` always wins, and keeps merge-base semantics — it names a
 * branch point, not a recorded state. When the map records a commit this checkout
 * does not have (a shallow clone, a rebased or pruned history), or records none
 * at all inside a git work tree, the staleness window cannot be established and
 * the map is not trusted.
 */
function diffBase(
  cwd: string,
  map: CoverageMap | undefined,
  since: string | undefined,
): DiffBase {
  if (since !== undefined) return { kind: 'base', since };
  if (map === undefined) return { kind: 'base' };
  if (map.commit === undefined) {
    return isGitWorkTree(cwd)
      ? {
          kind: 'untrusted',
          reason: 'map records no commit, so changes since it was recorded are unknown',
        }
      : { kind: 'base' };
  }
  // The commit arrives from a JSON file, which in CI came out of a restored
  // cache. It is passed to git as an argument, so require it to look like one.
  if (!/^[0-9a-f]{7,40}$/.test(map.commit)) {
    return {
      kind: 'untrusted',
      reason: 'map records a commit that is not a valid object name',
    };
  }
  if (!commitExists(cwd, map.commit)) {
    return {
      kind: 'untrusted',
      reason: `map was recorded at ${map.commit.slice(0, 12)}, which this checkout does not have`,
    };
  }
  return { kind: 'base', since: map.commit, exact: true };
}

/**
 * Compute the tests affected by the current diff. Falls open to a full run when
 * the map is unusable, a sentinel changed, or the diff cannot be computed.
 */
export async function selectAffected(init: SelectInit): Promise<AffectedResult> {
  const { cwd, config } = init;
  const testFiles = discoverTestFiles(cwd, config);
  const store = new LocalStore({ cwd, dir: config.store.dir });
  const map = await store.read();

  const fullRun = (reason: string): AffectedResult => ({
    fullRun: true,
    reason,
    tests: testFiles,
    selected: testFiles.map((file) => ({ file })),
  });

  // Discovery found nothing to choose between, so there is no selection to make
  // and an empty one would read as "nothing to run". A full run hands the runner
  // its own command unfiltered, which means its own discovery finds the tests
  // covsel's globs did not.
  if (testFiles.length === 0) return fullRun(noTestFilesFound(cwd, config));

  const base = diffBase(cwd, map, init.since);
  if (base.kind === 'untrusted') return fullRun(base.reason);

  let changes;
  try {
    changes = diffChanges(cwd, base.since, { exact: base.exact === true });
  } catch {
    return fullRun('could not compute a git diff');
  }

  // A dependency change is the one change nothing in the map moves for: vendored
  // code is outside what a recording maps, so the lockfile is the only place it
  // shows at all. Resolving it to package names is what lets that sentinel be
  // downgraded, and it is asked before the sentinel check so the files it speaks
  // for can be taken out of the diff -- they are not changes to reason about as
  // files any more, they are the package axis below.
  const deps = isUsableMap(map)
    ? dependencyChange({ cwd, config, map, changes })
    : undefined;
  if (deps?.fallOpen !== undefined) return fullRun(deps.fallOpen);
  const accounted = new Set<string>(deps?.accounted ?? []);
  const fileChanges =
    accounted.size === 0 ? changes : changes.filter((c) => !accounted.has(c.file));

  const policy = new FailOpenPolicy(config);
  if (policy.evaluate(map, fileChanges) === 'full-run') {
    return fullRun(fullRunReason(config, map, fileChanges));
  }

  if (map!.granularity === 'block' && config.granularity !== 'file') {
    annotateChangedBlocks(cwd, fileChanges, map!);
  }
  const units = await new FileSelector().affected(map!, fileChanges);
  const byPackage = packageAffected(map!, deps?.packages ?? []);
  if (byPackage === undefined) {
    return fullRun(
      'the map records an inventory but an entry says nothing about packages',
    );
  }
  const mandatory = await policy.mandatory(changes);
  const alwaysRun = testFiles.filter((f) => matchesAny(f, config.alwaysRun));

  // A test file the map says nothing about is a test whose coverage is unknown,
  // not a test that covers nothing. That happens when a recorder yielded no
  // units for it, or when a merged map is missing a shard — neither of which may
  // quietly deselect it.
  const mapped = new Set(map!.entries.map((e) => e.test.file));
  const unmapped = testFiles.filter((f) => !mapped.has(f));

  // An entry that credits nothing is the same claim in a different shape, and
  // gets the same answer. It is not the rare test that genuinely executes no
  // code: far more often the recorder could not see what the test executed,
  // because the test drives its subject in a child process, a worker, or a
  // browser its coverage mechanism does not reach. A recorder declares its blind
  // spots in `observed`, but that is one scope for the whole run and cannot say
  // "everything except what these particular tests do", so the empty entry falls
  // straight through it and no changed path can ever match it.
  //
  // The whole file runs, not the unit that credits nothing: a recorder that
  // could not see one unit of a file has not earned trust in what it recorded
  // for the units beside it. A test that really covers nothing then runs when it
  // need not, which is the cheap way to be wrong.
  const unmeasured = new Set(
    map!.entries.filter(measuredNothing).map((e) => e.test.file),
  );

  // Files that must run in full supersede any per-test selection for that file.
  const wholeFile = new Set<string>([
    ...mandatory.map((t) => t.file),
    ...alwaysRun,
    ...unmapped,
    // Drawn from discovery, like `unmapped`: an entry may outlive the test file
    // it names, and there is nothing to run for a file that is no longer there.
    ...testFiles.filter((f) => unmeasured.has(f)),
  ]);
  const selected: TestId[] = [...wholeFile].map((file) => ({ file }));
  const seen = new Set<string>();
  for (const u of [...units, ...byPackage]) {
    if (wholeFile.has(u.file)) continue;
    const key = `${u.file} ${u.name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(
      u.name !== undefined ? { file: u.file, name: u.name } : { file: u.file },
    );
  }
  sortUnits(selected);

  const tests = new Set<string>(selected.map((t) => t.file));
  return { fullRun: false, tests: [...tests], selected };
}

/**
 * The units whose entry ran code in a package whose resolution moved — or
 * `undefined` when the map is not in a state to be asked.
 *
 * The package axis, kept deliberately separate from the file axis. The
 * alternative considered and rejected was synthesising `Change` records with
 * `node_modules/` paths and letting the selector do this: those paths are
 * outside every recording's `observed` scope by construction, so each one would
 * trip `unobservedChange` and force the very full run this exists to avoid.
 *
 * Silence about a package here is a measurement, in the same narrow sense
 * silence about a source file is. It is sound only because everything that could
 * make it an artifact has already been ruled out: the recorder declared it
 * watches packages, the package was installed when the map was recorded, and the
 * tree provably reflects its lockfile. An entry that says nothing at all about
 * packages is the one remaining hole -- the map claims an inventory while an
 * entry disclaims the question -- and it cannot be reconciled here, so it is
 * reported rather than guessed at. Recording and merging both couple the two,
 * which leaves a hand-edited or foreign map as the way in.
 */
function packageAffected(
  map: CoverageMap,
  changed: readonly string[],
): TestId[] | undefined {
  if (changed.length === 0) return [];
  const moved = new Set(changed);
  const affected: TestId[] = [];
  for (const entry of map.entries) {
    if (entry.packages === undefined) return undefined;
    if (entry.packages.some((name) => moved.has(name))) affected.push(entry.test);
  }
  return affected;
}

/**
 * Order test units by file, then by name, so a selection is reproducible and
 * collapsing it to files yields the same sorted list as `tests`.
 */
function sortUnits(units: TestId[]): void {
  const key = (t: TestId): string => `${t.file}\0${t.name ?? ''}`;
  units.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * Resolve configuration for a run with this adapter: the project's own settings,
 * with the adapter's `defaultTestGlobs` filling in when the project named no
 * `testGlobs` of its own. Only the adapter can know that its runner's tests are
 * not `*.test.*` sources, and only the project can overrule it — so the
 * capability lives on the adapter and is applied here, once, for every consumer.
 */
export function resolveConfigFor(
  adapter: Adapter,
  raw: CovselConfigInput = {},
): CovselConfig {
  const globs = adapter.defaultTestGlobs;
  if (globs !== undefined && raw.testGlobs === undefined) {
    return resolveConfig({ ...raw, testGlobs: [...globs] });
  }
  return resolveConfig(raw);
}

export interface RunSelectedInit extends SelectionRunInit {
  adapter: Adapter;
}

/** What handing a selection to the runner produced. */
export interface SelectionOutcome {
  /** The runner's exit code — the worst one, if it took more than one invocation. */
  status: number;
  /**
   * What the runner printed, when covsel captured it instead of passing it
   * through. An adapter that runs the selection itself owns its child's stdio,
   * so nothing is captured for one of those.
   */
  output?: string;
}

/**
 * Hand one selection to the runner: the adapter's own narrowing when it has
 * one, otherwise the command with the adapter's formatted file list appended.
 * Both the CLI and the conformance suite build every selected invocation here,
 * so what the suite certifies is what the product runs.
 */
export function runSelected(init: RunSelectedInit): SelectionOutcome {
  const { adapter, selected, command, cwd } = init;
  const stdio = init.stdio ?? 'inherit';
  const [bin, ...rest] = command;
  if (bin === undefined) throw new Error('empty command');
  // An empty selection means there is nothing to run, not that the run needs no
  // filter: appending an empty file list would hand the runner its entire suite.
  // An adapter that narrows the run itself already invokes nothing for an empty
  // selection, so deciding it here is what keeps the two paths agreeing.
  if (selected.length === 0) return { status: 0 };
  if (adapter.runSelection) {
    return { status: adapter.runSelection({ selected, command, cwd, stdio }) };
  }
  const args = [...rest, ...adapter.formatSelection(selected)];
  // Silencing the runner still has to leave a failure diagnosable, so its output
  // is captured rather than discarded when it is not being passed through. The
  // ceiling matches what the adapters allow themselves: a verbose suite's output
  // is large, and truncating it into an error would obscure the real failure.
  const res =
    stdio === 'inherit'
      ? spawnSync(bin, args, { cwd, stdio: 'inherit' })
      : spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return { status: res.status ?? 1, ...(output ? { output } : {}) };
}

export interface RunInit extends SelectInit {
  adapter: Adapter;
  command: string[];
}

export interface RunAffectedSelectionInit extends Omit<SelectionRunInit, 'selected'> {
  adapter: Adapter;
  selection: AffectedResult;
}

/**
 * Run one already-computed selection. A full run invokes the command with no
 * file filter, so the runner's own full suite is what runs; anything else goes
 * through the adapter's narrowing. Callers that hold a selection already — a
 * watch loop reruns one per change — run it here rather than reselecting.
 */
export function runAffectedSelection(init: RunAffectedSelectionInit): SelectionOutcome {
  const { adapter, selection, command, cwd } = init;
  const [bin, ...rest] = command;
  if (bin === undefined) throw new Error('empty command');
  if (selection.fullRun) {
    const stdio = init.stdio ?? 'inherit';
    const res =
      stdio === 'inherit'
        ? spawnSync(bin, rest, { cwd, stdio: 'inherit' })
        : spawnSync(bin, rest, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.error) throw res.error;
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    return { status: res.status ?? 1, ...(output ? { output } : {}) };
  }
  return runSelected({
    adapter,
    selected: selection.selected,
    command,
    cwd,
    ...(init.stdio !== undefined ? { stdio: init.stdio } : {}),
  });
}

/**
 * Run only the affected tests by wrapping the runner. On a full run the runner
 * is invoked with no file filter (its own full suite). On an empty non-full
 * selection nothing is run and the exit code is 0.
 */
export async function runAffected(
  init: RunInit,
  onSelection?: (result: AffectedResult) => void,
): Promise<number> {
  const selection = await selectAffected(init);
  onSelection?.(selection);
  return runAffectedSelection({
    adapter: init.adapter,
    selection,
    command: init.command,
    cwd: init.cwd,
  }).status;
}

export interface StatusResult {
  mapPath: string;
  /**
   * Whether the store holds a map covsel can use, one it cannot, or no file at
   * all. The three are one decision to selection — anything but `usable` runs
   * everything — and three different answers to someone asking why, which is
   * the question this command exists to answer.
   */
  mapState: StoredMap['state'];
  /**
   * Why the stored map cannot be used, when `mapState` is `unusable`. Never the
   * grounds for a decision, only the sentence that saves a reader from looking
   * for a file that is right where covsel said it was.
   */
  unusableReason?: string;
  /**
   * Test files discovery found. Zero means covsel has nothing to select between,
   * whatever the map says, so it is reported alongside the map rather than
   * inferred from it.
   */
  discoveredTestCount?: number;
  recordedAt?: string;
  ageMs?: number;
  granularity?: string;
  /** Globs the recording was able to observe execution within. */
  observed?: string[];
  entryCount?: number;
  /**
   * Entries crediting no source at all. They are part of `entryCount` and they
   * measure nothing, so counting them separately is the only way a map that
   * narrows for half its tests is told apart from one that narrows for all of
   * them. Each such test is selected on every run.
   */
  unmeasuredEntryCount?: number;
  coveredFileCount?: number;
  coveredBlockCount?: number;
  changedSentinels: string[];
  nextIsFullRun: boolean;
  nextFullRunReason?: string;
}

export interface StatusInit {
  cwd: string;
  config: CovselConfig;
  now?: number;
}

/**
 * Whether the next `affected` would narrow, and why not when it would not.
 *
 * Shared by every command that says what covsel is about to do, so none of them
 * can answer it differently: a map that measured nothing, or one that cannot be
 * anchored to a commit, is a full run however healthy the file looks, and a
 * command that reads the entries without asking this would report the opposite.
 *
 * `blocked` is a reason that pre-empts the map's own verdict — there is nothing
 * to narrow to whatever the map says.
 */
function nextSelection(
  cwd: string,
  config: CovselConfig,
  map: CoverageMap | undefined,
  blocked?: string,
): { fullRun: boolean; reason?: string } {
  if (blocked !== undefined) return { fullRun: true, reason: blocked };
  const base = diffBase(cwd, map, undefined);
  if (base.kind === 'untrusted') return { fullRun: true, reason: base.reason };
  try {
    const changes = diffChanges(cwd, base.since, { exact: base.exact === true });
    // The same dependency step `selectAffected` takes, in the same order, for
    // the same reason: this reports what that would decide, and a status that
    // announced a full run for a lockfile bump the selection then downgrades is
    // worse than no status at all. Two derivations of one answer is the standing
    // hazard here -- they are kept together by both calling the same two
    // functions in the same sequence.
    const deps = isUsableMap(map)
      ? dependencyChange({ cwd, config, map, changes })
      : undefined;
    if (deps?.fallOpen !== undefined) return { fullRun: true, reason: deps.fallOpen };
    const accounted = new Set<string>(deps?.accounted ?? []);
    const fileChanges =
      accounted.size === 0 ? changes : changes.filter((c) => !accounted.has(c.file));
    return new FailOpenPolicy(config).evaluate(map, fileChanges) === 'full-run'
      ? { fullRun: true, reason: fullRunReason(config, map, fileChanges) }
      : { fullRun: false };
  } catch {
    return { fullRun: true, reason: 'could not compute a git diff' };
  }
}

/** Describe the current map and what the next `affected` would do. */
export async function computeStatus(init: StatusInit): Promise<StatusResult> {
  const { cwd, config } = init;
  const store = new LocalStore({ cwd, dir: config.store.dir });
  // The diagnostic read, because this command reports rather than decides. What
  // it decides is still the selection read's answer: nothing below narrows
  // anything unless the map came back usable.
  const stored = store.inspect();
  const map = stored.state === 'usable' ? stored.map : undefined;
  const now = init.now ?? Date.now();

  // Discovery is what `affected` would select from, so a status that did not
  // report it could describe a healthy map beside a run that executes nothing.
  //
  // A discovery that *failed* is not a discovery that found nothing, and saying
  // "no test files matched your globs" to someone whose problem is an unreadable
  // directory sends them to fix the one thing that is not wrong. `status` exists
  // to answer "why is covsel about to do this", so it may not guess here.
  let discovered: string[];
  let discoveryFailed: string | undefined;
  try {
    discovered = discoverTestFiles(cwd, config);
  } catch (e) {
    discovered = [];
    discoveryFailed = `test discovery failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  const noTests =
    discoveryFailed ??
    (discovered.length === 0 ? noTestFilesFound(cwd, config) : undefined);

  if (!map) {
    return {
      mapPath: store.path(),
      mapState: stored.state,
      ...(stored.state === 'unusable' ? { unusableReason: stored.reason } : {}),
      discoveredTestCount: discovered.length,
      changedSentinels: [],
      nextIsFullRun: true,
      // Always a reason now. Falling back to a generic "the map cannot be
      // trusted" left the one user who most needs to know — the one whose map
      // was rejected for a schema bump — with no hint that re-recording is the
      // fix, and a reading in which the map was lost.
      //
      // A rejected map answers in its own words, the same words `explain` uses,
      // rather than through the shared wording: "no usable map recorded" is what
      // an absent map is called, and saying it about a file that is sitting
      // right there is the misreport this all exists to stop.
      nextFullRunReason:
        noTests ??
        (stored.state === 'unusable'
          ? stored.reason
          : fullRunReason(config, undefined, [])),
    };
  }

  const coveredFiles = new Set<string>();
  const coveredBlocks = new Set<string>();
  let unmeasuredEntries = 0;
  for (const entry of map.entries) {
    if (measuredNothing(entry)) unmeasuredEntries += 1;
    for (const f of entry.files) coveredFiles.add(f.file);
    for (const b of entry.blocks ?? []) coveredBlocks.add(`${b.file}\0${b.blockHash}`);
  }

  const changedSentinels: string[] = [];
  for (const [rel, hash] of Object.entries(map.sentinelHashes)) {
    let current: string | undefined;
    try {
      current = hashFileContents(`${cwd}/${rel}`);
    } catch {
      current = undefined;
    }
    if (current !== hash) changedSentinels.push(rel);
  }

  const next = nextSelection(cwd, config, map, noTests);
  const nextIsFullRun = next.fullRun;
  const nextFullRunReason = next.reason;

  return {
    mapPath: store.path(),
    mapState: 'usable',
    discoveredTestCount: discovered.length,
    recordedAt: map.recordedAt,
    ageMs: now - Date.parse(map.recordedAt),
    granularity: map.granularity,
    observed: [...map.observed],
    entryCount: map.entries.length,
    unmeasuredEntryCount: unmeasuredEntries,
    coveredFileCount: coveredFiles.size,
    ...(coveredBlocks.size > 0 ? { coveredBlockCount: coveredBlocks.size } : {}),
    changedSentinels,
    nextIsFullRun,
    ...(nextFullRunReason ? { nextFullRunReason } : {}),
  };
}

/**
 * What the map says about one block of a file as it stands now.
 *
 * Only `uncovered` is the claim that nothing runs this code, and it is made
 * only when nothing else can account for the silence — because a change to a
 * block covsel would in fact select tests for, reported as covered by nothing,
 * sends a developer looking for the bug in the wrong place entirely.
 *
 * - `covered` — a recorded block with this hash, run by the units listed.
 * - `file-level` — no recorded block matches, but entries credit the whole file,
 *   and the selector falls back to file level for those: a change here runs them.
 * - `unmatched` — no recorded block matches, and blocks recorded for this file
 *   have since drifted out of it, so this may be one of them under a new hash.
 * - `uncovered` — no recorded block matches, nothing drifted, and no entry
 *   credits the file whole. Nothing recorded executes it.
 */
export type BlockVerdict = 'covered' | 'file-level' | 'unmatched' | 'uncovered';

/** One block of a source file as it stands now, and what the map says ran it. */
export interface ExplainedBlock {
  /** Function name, or the module block for the file's top-level skeleton. */
  name: string;
  hash: string;
  verdict: BlockVerdict;
  /** Recorded units that executed this block; empty unless `covered`. */
  coveredBy: TestId[];
}

/** One recorded test unit, and the sources its entry credits. */
export interface ExplainedUnit {
  test: TestId;
  /** Sources the unit covered, sorted and deduplicated. */
  sources: string[];
}

/** What the map knows about a path read as a source: what covers it. */
export interface SourceExplanation {
  /** Units whose entry credits this file, sorted by file then name. */
  coveredBy: TestId[];
  /**
   * The file's blocks as it stands on disk now, each with the units that ran
   * it. Present only at block granularity, and only when some entry actually
   * recorded blocks here — naming a block means re-parsing the current file, so
   * this is the current shape of the code answered against past recordings.
   */
  blocks?: ExplainedBlock[];
  /** Why block detail is absent, when the map is block-granular and it is. */
  blocksUnavailable?: string;
  /**
   * Recorded block hashes this file no longer contains: blocks that changed
   * since the recording. These are exactly the hashes that make a change to
   * this file select the tests that ran them.
   */
  changedBlocks: number;
  /**
   * Units that credit the whole file without recording a block in it. Their
   * coverage cannot be attributed to any one block, so block detail below them
   * is not the whole answer for this file.
   */
  fileOnly: TestId[];
}

/** What the map knows about a path read as a test: what it covered. */
export interface TestExplanation {
  units: ExplainedUnit[];
  /**
   * True when no entry records this test file. An unrecorded test's coverage is
   * unknown rather than empty, so selection always runs it.
   */
  unrecorded: boolean;
  /**
   * True when a unit recorded here credits no source. That entry claims nothing
   * a diff can be matched against, which is unknown coverage wearing a
   * recorded entry's clothes — so, like an unrecorded test, this file always
   * runs. Reported separately because the two look nothing alike in the map and
   * a reader chasing "why does this always run" has to be able to tell which
   * one they have.
   */
  unmeasured: boolean;
}

/**
 * Why a change to one path forces a full run, and whether it always does.
 *
 * Sentinels always do: covsel cannot attribute a change in one to any test, so
 * the whole suite is the only sound answer. Its own config does not, since the
 * question there is whether the change moved a value covsel reads — and telling
 * a reader "a change here runs everything" when a reworded comment does nothing
 * of the sort is the drift this separation exists to prevent.
 */
export interface FullRunTrigger {
  /** True when any change to the path forces a full run, whatever it changed. */
  always: boolean;
  /** The whole answer, as a sentence: what a change does, and why. */
  why: string;
}

export interface ExplainResult {
  /**
   * False when the path itself could not be explained. `error` says why, and no
   * other field carries an answer about the path.
   */
  ok: boolean;
  error?: string;
  /** The path, repo-relative, or as given when it could not be resolved. */
  file: string;
  mapPath: string;
  /**
   * Whether the store holds a map covsel can use, one it cannot, or no file at
   * all. Anything but `usable` means there is nothing to explain — and which of
   * the two it is decides whether the reader should go looking for the file.
   */
  mapState: StoredMap['state'];
  /** Why there is nothing to explain, when no usable map is stored. */
  noMapReason?: string;
  recordedAt?: string;
  granularity?: Granularity;
  /** True when the path is in the working tree; a map may outlive its files. */
  present: boolean;
  /**
   * True when the map's observed globs cover this path. Outside them the map's
   * silence is an artifact of where the recorder was looking rather than a
   * measurement, and a change here falls open to a full run.
   */
  observed?: boolean;
  /**
   * What a change to this path on its own does to the next run, when it does
   * anything at all.
   */
  forcesFullRun?: FullRunTrigger;
  /** True when an alwaysRun glob matches, so this test runs whatever the diff. */
  alwaysRun: boolean;
  /** True when the configured test globs match this path. */
  isTestPath: boolean;
  /**
   * True when the path is inside a directory covsel never walks. Discovery and
   * coverage attribution both skip these, so a test file here is not one that
   * "always runs until it is recorded" — it is one that never runs at all.
   */
  excluded: boolean;
  /**
   * Whether the next selection would be a full run whatever this path says, and
   * why. A map that measured nothing or cannot be anchored to a commit runs
   * everything, and "no recorded test covers this file" read beside that would
   * otherwise say a change here selects nothing.
   */
  nextIsFullRun?: boolean;
  nextFullRunReason?: string;
  source?: SourceExplanation;
  test?: TestExplanation;
}

export interface ExplainInit {
  cwd: string;
  config: CovselConfig;
  /** The path to explain: absolute, or relative to `cwd`. */
  path: string;
}

/** Append `test` under `key`, creating the bucket on first use. */
function pushUnit(index: Map<string, TestId[]>, key: string, test: TestId): void {
  let bucket = index.get(key);
  if (!bucket) index.set(key, (bucket = []));
  bucket.push(test);
}

/**
 * Sort a unit list, dropping units that appear twice. The map is a file on
 * disk, so nothing here can assume it was written by the recorder that would
 * have kept one entry per unit.
 */
function distinctUnits(units: TestId[]): TestId[] {
  const seen = new Set<string>();
  const out: TestId[] = [];
  for (const unit of units) {
    const key = `${unit.file}\0${unit.name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(unit);
  }
  sortUnits(out);
  return out;
}

/**
 * The map, read in the other direction: what the map says about one path.
 *
 * The entries answer "what did this test cover"; the question a developer has
 * when selection looks wrong is the reverse one, about a file. This indexes the
 * entries by covered path and reports what it finds, along with the facts that
 * decide what a change there would do — whether the recording could observe it,
 * whether a sentinel or alwaysRun glob matches, and whether the map records this
 * test at all.
 *
 * Read-only, and deliberately unopinionated about which direction the path is:
 * a path that is both a test and something another test covers gets both
 * answers, since either one alone is a half-truth about what a change to it
 * selects.
 */
export async function explainPath(init: ExplainInit): Promise<ExplainResult> {
  const { cwd, config } = init;
  const store = new LocalStore({ cwd, dir: config.store.dir });
  const mapPath = store.path();
  // Read as a diagnostic, like status: this command answers questions about the
  // map, so "there is no usable map" is an answer that has to say which kind.
  const stored = store.inspect();
  const fail = (file: string, error: string): ExplainResult => ({
    ok: false,
    error,
    file,
    mapPath,
    mapState: stored.state,
    present: false,
    alwaysRun: false,
    isTestPath: false,
    excluded: false,
  });

  const abs = resolve(cwd, init.path);
  // Asked before the path is made repo-relative, so the repo root answers as
  // the directory it is rather than as a path outside itself.
  let stats;
  try {
    stats = statSync(abs);
  } catch {
    // A path the map records but the tree no longer has is still explainable,
    // and saying so is the answer to "why does nothing cover this now".
    stats = undefined;
  }
  // A directory would have to be answered as a summary over everything under
  // it, which is a different question with a different shape; refusing names
  // what was asked rather than answering something else.
  if (stats?.isDirectory()) {
    return fail(init.path, `${init.path} is a directory -- explain takes a single file`);
  }

  const rel = toRepoRelative(cwd, abs);
  if (rel === undefined) {
    return fail(init.path, `${init.path} is outside ${cwd}`);
  }
  const present = stats?.isFile() ?? false;

  const isTestPath = isTestFile(rel, config);
  const alwaysRun = matchesAny(rel, config.alwaysRun);
  const excluded = isExcludedRel(rel);
  // A sentinel is not the only path a change to which invalidates the map:
  // covsel's own config decides what the map means, and the policy asks about it
  // without consulting the sentinel list. The sentinel answer is reported first
  // even for a config file, because it is the one that holds: a project that
  // listed the file said any change to it runs everything, and selection honors
  // that ahead of anything the values say.
  const isConfigFile = (CONFIG_FILES as readonly string[]).includes(rel);
  const fullRunTrigger = (
    recorded: CoverageMap | undefined,
  ): FullRunTrigger | undefined => {
    if (matchesAny(rel, config.sentinels)) {
      return {
        always: true,
        why:
          'a change here forces one -- it is a sentinel, so a change to it ' +
          'invalidates the map',
      };
    }
    if (!isConfigFile) return undefined;
    return recorded?.config !== undefined
      ? {
          always: false,
          why:
            'a change here forces one only when it moves a value covsel reads ' +
            "-- it is covsel's own configuration, and the map records the " +
            'values it was recorded under',
        }
      : {
          always: true,
          why:
            "a change here forces one -- it is covsel's own configuration, and " +
            'the map records no values to compare against',
        };
  };

  // The diagnostic read, as in `status`: which kind of nothing there is to
  // explain is part of the answer. What decides anything is still the usable
  // map, or the absence of one.
  const map = stored.state === 'usable' ? stored.map : undefined;
  const forcesFullRun = fullRunTrigger(map);
  if (map === undefined) {
    if (!present) return fail(rel, `${rel} is not in ${cwd}`);
    return {
      ok: true,
      file: rel,
      mapPath,
      mapState: stored.state,
      // A map that was rejected says so in its own words; one that is not there
      // gets the wording every other command uses for the same state.
      noMapReason:
        stored.state === 'unusable'
          ? stored.reason
          : fullRunReason(config, undefined, []),
      present,
      ...(forcesFullRun !== undefined ? { forcesFullRun } : {}),
      alwaysRun,
      isTestPath,
      excluded,
    };
  }

  const coveredBy: TestId[] = [];
  const fileOnly: TestId[] = [];
  const units: ExplainedUnit[] = [];
  const unitsByBlock = new Map<string, TestId[]>();
  const recordedHashes = new Set<string>();
  for (const entry of map.entries) {
    if (entry.test.file === rel) {
      units.push({
        test: entry.test,
        sources: [...new Set(entry.files.map((f) => f.file))].sort(),
      });
    }
    const creditsFile = entry.files.some((f) => f.file === rel);
    let creditsBlock = false;
    for (const block of entry.blocks ?? []) {
      if (block.file !== rel) continue;
      creditsBlock = true;
      recordedHashes.add(block.blockHash);
      pushUnit(unitsByBlock, block.blockHash, entry.test);
    }
    if (creditsFile || creditsBlock) coveredBy.push(entry.test);
    if (creditsFile && !creditsBlock) fileOnly.push(entry.test);
  }
  // Same order selection uses, so a unit here and a selected unit read alike.
  const unitKey = (u: ExplainedUnit): string => `${u.test.file}\0${u.test.name ?? ''}`;
  units.sort((a, b) => (unitKey(a) < unitKey(b) ? -1 : unitKey(a) > unitKey(b) ? 1 : 0));

  // Nothing on disk and nothing in the map: covsel has no answer to give, and an
  // empty report would read as "nothing covers this" for a path that is most
  // likely a typo.
  if (!present && coveredBy.length === 0 && units.length === 0) {
    return fail(rel, `${rel} is not in ${cwd} and the map does not mention it`);
  }

  // A path is explained as a source when it is not a test, and also when it is
  // one that something else covers — a test file another test imports is both,
  // and only saying so answers what a change to it selects.
  const wantSource = !isTestPath || coveredBy.length > 0;
  const wantTest = isTestPath || units.length > 0;

  let source: SourceExplanation | undefined;
  if (wantSource) {
    let blocks: ExplainedBlock[] | undefined;
    let blocksUnavailable: string | undefined;
    let changedBlocks = 0;
    if (map.granularity === 'block') {
      if (recordedHashes.size === 0) {
        // Every function would be listed as covered by nothing. For a file its
        // own tests credit whole that is a rendering artifact rather than a gap,
        // and worth saying; for a file nothing covers at all, the file-level
        // answer has already said it.
        if (coveredBy.length > 0) {
          blocksUnavailable = 'the tests that cover this file recorded whole files';
        }
      } else if (!present) {
        blocksUnavailable =
          'the file is not in the working tree, so its blocks cannot be named';
      } else {
        try {
          // Block hashes are opaque, so naming one means parsing the file as it
          // is now and matching hashes. That is also what makes drift visible: a
          // recorded hash the current file no longer contains is a block that
          // changed since the recording.
          const current = extractBlocks(readFileSync(abs, 'utf8'), rel);
          const currentHashes = new Set(current.map((b) => b.hash));
          changedBlocks = [...recordedHashes].filter((h) => !currentHashes.has(h)).length;
          blocks = current.map((block) => {
            const ran = distinctUnits(unitsByBlock.get(block.hash) ?? []);
            // Order matters: each verdict below is a weaker statement than the
            // one before it, and only the last one claims nothing runs this
            // code. Anything that could account for the silence outranks it.
            const verdict: BlockVerdict =
              ran.length > 0
                ? 'covered'
                : fileOnly.length > 0
                  ? 'file-level'
                  : changedBlocks > 0
                    ? 'unmatched'
                    : 'uncovered';
            return { name: block.name, hash: block.hash, verdict, coveredBy: ran };
          });
        } catch (e) {
          blocksUnavailable = `the file could not be read: ${
            e instanceof Error ? e.message : String(e)
          }`;
        }
      }
    }
    source = {
      coveredBy: distinctUnits(coveredBy),
      ...(blocks !== undefined ? { blocks } : {}),
      ...(blocksUnavailable !== undefined ? { blocksUnavailable } : {}),
      changedBlocks,
      fileOnly: distinctUnits(fileOnly),
    };
  }

  const next = nextSelection(cwd, config, map);
  return {
    ok: true,
    file: rel,
    mapPath,
    mapState: 'usable',
    recordedAt: map.recordedAt,
    granularity: map.granularity,
    present,
    observed: makeStrictMatcher(map.observed)(rel),
    ...(forcesFullRun !== undefined ? { forcesFullRun } : {}),
    alwaysRun,
    isTestPath,
    excluded,
    nextIsFullRun: next.fullRun,
    ...(next.reason !== undefined ? { nextFullRunReason: next.reason } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(wantTest
      ? {
          test: {
            units,
            unrecorded: units.length === 0,
            // Asked of the entries through the same predicate selection uses,
            // rather than re-derived from the sources listed above: explain
            // exists to account for what the selector did, so it may not answer
            // this from its own copy of the question.
            unmeasured: map.entries.some(
              (e) => e.test.file === rel && measuredNothing(e),
            ),
          },
        }
      : {}),
  };
}
