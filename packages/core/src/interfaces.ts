/**
 * Stable interfaces for the five core layers. Adapters depend on these (and
 * only these); implementations live in core or in pluggable packages.
 */

import type { CovselConfig } from './config.js';
import type { CoverageMap, CoveredBlock, CoveredFile, TestId } from './schema.js';

/** Raw V8 coverage for one observation window, before source-mapping. */
export interface RawCoverage {
  /** V8 ScriptCoverage-shaped result, or path to a NODE_V8_COVERAGE dump. */
  scripts: unknown[];
}

/**
 * Observer — turns "a test ran" into a set of executed source ranges.
 * Process mode via NODE_V8_COVERAGE observes a whole test *file*.
 * Inspector snapshot-diff via Profiler.takePreciseCoverage observes each *test*.
 */
export interface Observer {
  startTest(id: TestId): Promise<void>;
  endTest(id: TestId): Promise<RawCoverage>;
}

/**
 * Mapper — the hard part. Maps transpiled/bundled execution back to original
 * sources via source maps, and fingerprints blocks by content hash.
 */
export interface Mapper {
  toFiles(raw: RawCoverage): Promise<CoveredFile[]>;
  toBlocks(raw: RawCoverage): Promise<CoveredBlock[]>;
}

/** Store — persists and retrieves maps; the local one is a `.covsel/` directory. */
export interface Store {
  read(): Promise<CoverageMap | undefined>;
  write(map: CoverageMap): Promise<void>;
  /** Merge shard maps into one (CI shard-merge). */
  merge(maps: CoverageMap[]): Promise<CoverageMap>;
}

/** A change detected in the working tree / diff range. */
export interface Change {
  file: string;
  /** Block hashes that changed, when block granularity is available. */
  changedBlockHashes?: string[];
  kind: 'modified' | 'added' | 'deleted' | 'renamed';
}

/** Selector — git diff → impacted test ids. */
export interface Selector {
  affected(map: CoverageMap, changes: Change[]): Promise<TestId[]>;
}

/**
 * Policy — every tension resolves toward over-selection:
 *  - new/changed test files with no map entry → always run
 *  - sentinel change → invalidate the map, run everything
 *  - alwaysRun globs → always selected
 * The catastrophic failure is skipping a needed test; Policy exists to make
 * that structurally impossible.
 */
export interface Policy {
  /** Returns 'full-run' when the map cannot be trusted for this diff. */
  evaluate(map: CoverageMap | undefined, changes: Change[]): 'select' | 'full-run';
  /** Tests that must run regardless of the map (new tests, alwaysRun globs). */
  mandatory(changes: Change[]): Promise<TestId[]>;
}

/** The sources one observation window executed. */
export interface RecordedTest {
  files: CoveredFile[];
  /** Executed function/module blocks, when recording at block granularity. */
  blocks: CoveredBlock[];
}

/** One recorded map entry: a test id and the sources that test executed. */
export interface RecordedUnit extends RecordedTest {
  test: TestId;
}

/**
 * A recorder observes one test file and returns one recorded unit per test it
 * saw — a single whole-file unit for whole-file recorders, or one unit per
 * individual test for per-test recorders. Each recorder obtains its coverage
 * from its own tool — the runner's built-in coverage, or Node's built-in V8
 * engine via `NODE_V8_COVERAGE`.
 */
export interface Recorder {
  /**
   * Repo-relative globs this recorder is able to observe execution within,
   * stamped onto the map it produces as `observed`.
   *
   * This is a claim about recall, not about what the runner happens to execute:
   * declare a path only when, had code there run, this recorder would have seen
   * it. Everything outside falls open on change, because the map's silence about
   * it means nothing. Under-claiming costs CI minutes; over-claiming skips tests.
   * A recorder that would see anything that ran declares `OBSERVES_EVERYTHING`.
   */
  readonly observes: readonly string[];
  record(testFile: string): Promise<RecordedUnit[]>;
  /**
   * Scripts the most recent `record` executed, could not map back to any source,
   * and accepted anyway because the project listed them in
   * `sourceMaps.allowUnmappable`. Each one is coverage the map is missing, so a
   * recorder that offers the accommodation reports what it let through and
   * consumers say so; an unmappable script nobody accepted fails the recording
   * instead.
   */
  unmappableAllowed?(): string[];
}

/** What an adapter needs to build a recorder for one project. */
export interface RecorderInit {
  /** The runner command to wrap, as the user gave it, e.g. `['vitest', 'run']`. */
  command: string[];
  cwd: string;
  config: CovselConfig;
}

/** What an adapter needs to run one computed selection through its runner. */
export interface SelectionRunInit {
  /** The selected test units. A unit without a `name` means the whole file. */
  selected: TestId[];
  /** The runner command to narrow, as the user gave it. */
  command: string[];
  cwd: string;
  /** Child stdio (default `'inherit'`, so the user sees the runner's output). */
  stdio?: 'inherit' | 'ignore';
}

/**
 * Adapter — the only per-runner surface, and one object per runner. It carries
 * everything a consumer needs to drive that runner: what to call it, how to
 * observe it, how to hand a selection back to it, and whatever it can do beyond
 * the file-list baseline. Implementations call observer.startTest/endTest around
 * each test and translate a selection into the runner's native input.
 *
 * The optional members are capabilities, not configuration: an adapter that
 * omits them gets covsel's universal behaviour — discover `*.test.*` files, run
 * a selection by appending a file list — and one that has more to offer says so
 * in a way a consumer can read off the object and the compiler can check.
 */
export interface Adapter {
  readonly name: string;
  /**
   * The selected test files, deduplicated, ready to append to the runner's
   * command line. Per-test ids of one file collapse to that file once: narrowing
   * a run to individual tests needs runner-specific flags and ordering, so an
   * adapter that selects per test exposes that through `runSelection` rather
   * than through this list.
   */
  formatSelection(tests: TestId[]): string[];
  /** Build the recorder `covsel record` observes this runner with. */
  createRecorder(init: RecorderInit): Recorder;
  /**
   * Globs to discover tests with when the project has not set `testGlobs`.
   * cucumber's tests are `.feature` files, not the default `*.test.*` sources,
   * so its adapter has to be able to find them zero-config.
   */
  readonly defaultTestGlobs?: readonly string[];
  /**
   * Run a selection through the runner's own filtering, returning its exit code.
   * Present only for adapters that record individual tests; without one the
   * runner is handed the formatted file list.
   */
  runSelection?(init: SelectionRunInit): number;
}
