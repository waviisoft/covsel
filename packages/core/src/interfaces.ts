/**
 * Stable interfaces for the five core layers. Adapters depend on these (and
 * only these); implementations live in core or in pluggable packages.
 */

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

/** Store — persists and retrieves maps (local .covsel/, GHA cache, S3/GCS). */
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

/**
 * Adapter — the only per-runner surface. Implementations call
 * observer.startTest/endTest around each test and translate a selection into
 * the runner's native input (file list, tags, feature:line, …).
 */
export interface Adapter {
  readonly name: string;
  /** Format selected tests as arguments/stdin for the runner. */
  formatSelection(tests: TestId[]): string[];
}
