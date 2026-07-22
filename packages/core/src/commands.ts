import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blockHashesOf } from './blocks.js';
import type { CovselConfig } from './config.js';
import { discoverTestFiles } from './discover.js';
import { diffChanges, gitHeadCommit } from './git.js';
import type { Change } from './interfaces.js';
import { makeMatcher, matchesAny } from './match.js';
import { V8FileMapper } from './mapper.js';
import { ProcessObserver } from './observer.js';
import { hashFileContents, walkFiles } from './paths.js';
import { FailOpenPolicy, fullRunReason } from './policy.js';
import {
  type CoverageMap,
  type CoveredBlock,
  type CoveredFile,
  type Granularity,
  MAP_SCHEMA_VERSION,
  type MapEntry,
} from './schema.js';
import { FileSelector } from './selector.js';
import { LocalStore } from './store.js';

/** What one recorder run learned about a test file: its covered files and blocks. */
export interface RecordedTest {
  files: CoveredFile[];
  /** Executed function/module blocks, when recording at block granularity. */
  blocks: CoveredBlock[];
}

/**
 * A recorder observes one test file and returns the sources it executed. The
 * generic recorder uses NODE_V8_COVERAGE; per-runner adapters can provide their
 * own (e.g. for runners that transform sources before executing them).
 */
export interface Recorder {
  record(testFile: string): Promise<RecordedTest>;
}

export interface GenericRecorderInit {
  command: string[];
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs' | 'granularity'>;
  env?: NodeJS.ProcessEnv;
}

/** The Level-0 recorder: ProcessObserver (NODE_V8_COVERAGE) piped into the V8 mapper. */
export function createGenericRecorder(init: GenericRecorderInit): Recorder {
  const observer = new ProcessObserver({
    command: init.command,
    cwd: init.cwd,
    ...(init.env ? { env: init.env } : {}),
  });
  const mapper = new V8FileMapper({ cwd: init.cwd, config: init.config });
  const wantBlocks = init.config.granularity !== 'file';
  return {
    async record(testFile: string) {
      await observer.startTest({ file: testFile });
      const raw = await observer.endTest({ file: testFile });
      const files = await mapper.toFiles(raw);
      const blocks = wantBlocks ? await mapper.toBlocks(raw) : [];
      return { files, blocks };
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
): CoverageMap {
  const commit = gitHeadCommit(cwd);
  const granularity: Granularity = config.granularity === 'file' ? 'file' : 'block';
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity,
    ...(commit ? { commit } : {}),
    recordedAt,
    sentinelHashes: hashSentinels(cwd, config.sentinels),
    entries,
  };
}

export interface RecordEvent {
  kind: 'recorded' | 'failed';
  file: string;
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
      const recorded = await recorder.record(file);
      entries.push({
        test: { file },
        files: recorded.files,
        ...(wantBlocks && recorded.blocks.length > 0 ? { blocks: recorded.blocks } : {}),
      });
      init.onEvent?.({ kind: 'recorded', file, sources: recorded.files.length });
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
  const map = assembleMap(entries, cwd, config, recordedAt);
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
}

export interface SelectInit {
  cwd: string;
  config: CovselConfig;
  since?: string;
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

  let changes;
  try {
    changes = diffChanges(cwd, init.since);
  } catch {
    return { fullRun: true, reason: 'could not compute a git diff', tests: testFiles };
  }

  const policy = new FailOpenPolicy(config);
  if (policy.evaluate(map, changes) === 'full-run') {
    return {
      fullRun: true,
      reason: fullRunReason(config, map, changes),
      tests: testFiles,
    };
  }

  if (map!.granularity === 'block' && config.granularity !== 'file') {
    annotateChangedBlocks(cwd, changes, map!);
  }
  const selected = await new FileSelector().affected(map!, changes);
  const mandatory = await policy.mandatory(changes);
  const alwaysRun = testFiles.filter((f) => matchesAny(f, config.alwaysRun));
  const tests = new Set<string>([
    ...selected.map((t) => t.file),
    ...mandatory.map((t) => t.file),
    ...alwaysRun,
  ]);
  return { fullRun: false, tests: [...tests].sort() };
}

export interface RunInit extends SelectInit {
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
  if (!selection.fullRun && selection.tests.length === 0) return 0;
  const args = selection.fullRun ? rest : [...rest, ...selection.tests];
  const res = spawnSync(bin, args, { cwd: init.cwd, stdio: 'inherit' });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

export interface StatusResult {
  mapPath: string;
  exists: boolean;
  recordedAt?: string;
  ageMs?: number;
  granularity?: string;
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
  try {
    const changes = diffChanges(cwd);
    const decision = new FailOpenPolicy(config).evaluate(map, changes);
    nextIsFullRun = decision === 'full-run';
    if (nextIsFullRun) nextFullRunReason = fullRunReason(config, map, changes);
  } catch {
    nextFullRunReason = 'could not compute a git diff';
  }

  return {
    mapPath: store.path(),
    exists: true,
    recordedAt: map.recordedAt,
    ageMs: now - Date.parse(map.recordedAt),
    granularity: map.granularity,
    entryCount: map.entries.length,
    coveredFileCount: coveredFiles.size,
    ...(coveredBlocks.size > 0 ? { coveredBlockCount: coveredBlocks.size } : {}),
    changedSentinels,
    nextIsFullRun,
    ...(nextFullRunReason ? { nextFullRunReason } : {}),
  };
}
