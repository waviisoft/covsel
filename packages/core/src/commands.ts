import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blockHashesOf } from './blocks.js';
import { type CovselConfig, resolveConfig } from './config.js';
import { discoverTestFiles } from './discover.js';
import { commitExists, diffChanges, gitHeadCommit, isGitWorkTree } from './git.js';
import type { Adapter, Change, Recorder, SelectionRunInit } from './interfaces.js';
import { makeMatcher, matchesAny } from './match.js';
import { V8FileMapper } from './mapper.js';
import { ProcessObserver } from './observer.js';
import { hashFileContents, walkFiles } from './paths.js';
import { FailOpenPolicy, fullRunReason } from './policy.js';
import {
  type CoverageMap,
  type Granularity,
  MAP_SCHEMA_VERSION,
  type MapEntry,
  type TestId,
} from './schema.js';
import { FileSelector } from './selector.js';
import { LocalStore } from './store.js';

export interface GenericRecorderInit {
  command: string[];
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs' | 'granularity'>;
  env?: NodeJS.ProcessEnv;
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
  return {
    // NODE_V8_COVERAGE is inherited by child processes and dumps every script
    // they load, so anything the run executes anywhere in the process tree is
    // visible to this recorder wherever it lives in the repo.
    observes: OBSERVES_EVERYTHING,
    async record(testFile: string) {
      await observer.startTest({ file: testFile });
      const raw = await observer.endTest({ file: testFile });
      const files = await mapper.toFiles(raw);
      const blocks = wantBlocks ? await mapper.toBlocks(raw) : [];
      return [{ test: { file: testFile }, files, blocks }];
    },
  };
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
  config: Pick<CovselConfig, 'sentinels' | 'granularity'>,
  recordedAt: string,
  observed: readonly string[],
): CoverageMap {
  const commit = gitHeadCommit(cwd);
  // Reflect what was actually recorded: per-test (node:test) recorders capture
  // no blocks, so the map is file-granular even when config asks for block.
  const hasBlocks = entries.some((e) => (e.blocks?.length ?? 0) > 0);
  const granularity: Granularity =
    config.granularity !== 'file' && hasBlocks ? 'block' : 'file';
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity,
    ...(commit ? { commit } : {}),
    recordedAt,
    sentinelHashes: hashSentinels(cwd, config.sentinels),
    observed: [...observed],
    entries,
  };
}

export interface RecordEvent {
  kind: 'recorded' | 'failed';
  file: string;
  /** Number of test units recorded from this file (per-test recorders yield many). */
  tests?: number;
  sources?: number;
  reason?: string;
}

export interface RecordResult {
  ok: boolean;
  recorded: number;
  failures: { file: string; reason: string }[];
  mapPath: string;
  testFiles: string[];
  map?: CoverageMap;
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
 * Record a fresh map. Runs the recorder over every discovered test file. If any
 * file fails to record (e.g. a failing test invalidates its coverage), the map
 * is *not* written — a partial map cannot be trusted for selection.
 */
export async function recordMap(init: RecordInit): Promise<RecordResult> {
  const { cwd, config, recorder } = init;
  const testFiles = discoverTestFiles(cwd, config);
  const store = new LocalStore({ cwd, dir: config.store.dir });
  const entries: MapEntry[] = [];
  const failures: { file: string; reason: string }[] = [];

  const wantBlocks = config.granularity !== 'file';
  for (const file of testFiles) {
    try {
      const units = await recorder.record(file);
      let sources = 0;
      for (const unit of units) {
        entries.push({
          test: unit.test,
          files: unit.files,
          ...(wantBlocks && unit.blocks.length > 0 ? { blocks: unit.blocks } : {}),
        });
        sources += unit.files.length;
      }
      init.onEvent?.({ kind: 'recorded', file, tests: units.length, sources });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ file, reason });
      init.onEvent?.({ kind: 'failed', file, reason });
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
  const map = assembleMap(entries, cwd, config, recordedAt, recorder.observes);
  await store.write(map);
  return {
    ok: true,
    recorded: entries.length,
    failures: [],
    mapPath: store.path(),
    testFiles,
    map,
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
  /** Selected test files, repo-relative, sorted, deduplicated. */
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

  const base = diffBase(cwd, map, init.since);
  if (base.kind === 'untrusted') return fullRun(base.reason);

  let changes;
  try {
    changes = diffChanges(cwd, base.since, { exact: base.exact === true });
  } catch {
    return fullRun('could not compute a git diff');
  }

  const policy = new FailOpenPolicy(config);
  if (policy.evaluate(map, changes) === 'full-run') {
    return fullRun(fullRunReason(config, map, changes));
  }

  if (map!.granularity === 'block' && config.granularity !== 'file') {
    annotateChangedBlocks(cwd, changes, map!);
  }
  const units = await new FileSelector().affected(map!, changes);
  const mandatory = await policy.mandatory(changes);
  const alwaysRun = testFiles.filter((f) => matchesAny(f, config.alwaysRun));

  // A test file the map says nothing about is a test whose coverage is unknown,
  // not a test that covers nothing. That happens when a recorder yielded no
  // units for it, or when a merged map is missing a shard — neither of which may
  // quietly deselect it.
  const mapped = new Set(map!.entries.map((e) => e.test.file));
  const unmapped = testFiles.filter((f) => !mapped.has(f));

  // Files that must run in full supersede any per-test selection for that file.
  const wholeFile = new Set<string>([
    ...mandatory.map((t) => t.file),
    ...alwaysRun,
    ...unmapped,
  ]);
  const selected: TestId[] = [...wholeFile].map((file) => ({ file }));
  const seen = new Set<string>();
  for (const u of units) {
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
  raw: Partial<CovselConfig> = {},
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
  const [bin, ...rest] = init.command;
  if (bin === undefined) throw new Error('empty command');
  if (selection.fullRun) {
    const res = spawnSync(bin, rest, { cwd: init.cwd, stdio: 'inherit' });
    if (res.error) throw res.error;
    return res.status ?? 1;
  }
  return runSelected({
    adapter: init.adapter,
    selected: selection.selected,
    command: init.command,
    cwd: init.cwd,
  }).status;
}

export interface StatusResult {
  mapPath: string;
  exists: boolean;
  recordedAt?: string;
  ageMs?: number;
  granularity?: string;
  /** Globs the recording was able to observe execution within. */
  observed?: string[];
  entryCount?: number;
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

/** Describe the current map and what the next `affected` would do. */
export async function computeStatus(init: StatusInit): Promise<StatusResult> {
  const { cwd, config } = init;
  const store = new LocalStore({ cwd, dir: config.store.dir });
  const map = await store.read();
  const now = init.now ?? Date.now();

  if (!map) {
    return {
      mapPath: store.path(),
      exists: false,
      changedSentinels: [],
      nextIsFullRun: true,
    };
  }

  const coveredFiles = new Set<string>();
  const coveredBlocks = new Set<string>();
  for (const entry of map.entries) {
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

  let nextIsFullRun = true;
  let nextFullRunReason: string | undefined;
  const base = diffBase(cwd, map, undefined);
  if (base.kind === 'untrusted') {
    nextFullRunReason = base.reason;
  } else {
    try {
      const changes = diffChanges(cwd, base.since, { exact: base.exact === true });
      const decision = new FailOpenPolicy(config).evaluate(map, changes);
      nextIsFullRun = decision === 'full-run';
      if (nextIsFullRun) nextFullRunReason = fullRunReason(config, map, changes);
    } catch {
      nextFullRunReason = 'could not compute a git diff';
    }
  }

  return {
    mapPath: store.path(),
    exists: true,
    recordedAt: map.recordedAt,
    ageMs: now - Date.parse(map.recordedAt),
    granularity: map.granularity,
    observed: [...map.observed],
    entryCount: map.entries.length,
    coveredFileCount: coveredFiles.size,
    ...(coveredBlocks.size > 0 ? { coveredBlockCount: coveredBlocks.size } : {}),
    changedSentinels,
    nextIsFullRun,
    ...(nextFullRunReason ? { nextFullRunReason } : {}),
  };
}
