import type { Adapter, CovselConfig, Recorder, TestId } from '@covsel/core';

/**
 * Identifies one of the two test units the suite reasons about. `name` is set
 * only by adapters that select individual tests or scenarios; when both units
 * live in the same file, it is what tells them apart.
 */
export interface ConformanceUnit {
  /** Test file (or feature file) holding this unit, repo-relative. */
  testFile: string;
  /** Individual test / scenario name, for adapters that record per test. */
  name?: string;
  /** A source file this unit executes and the other unit does not. */
  source: string;
}

/**
 * A throwaway project the suite writes, records, and edits. It must contain two
 * units that execute different sources, so the suite can tell precise selection
 * from "everything ran".
 */
export interface ConformanceFixture {
  /** Files to write into the project, repo-relative path → contents. */
  files: Record<string, string>;
  /** Command the recorder wraps, e.g. `['node', '--test']`. */
  command: string[];
  /** Directory to link as `node_modules`, for runners that need dependencies. */
  nodeModulesFrom?: string;
  /** Config overrides, e.g. `testGlobs` for runners whose tests are not `*.test.*`. */
  config?: Partial<CovselConfig>;
  units: { a: ConformanceUnit; b: ConformanceUnit };
  /** A test file that does not exist at record time, added later by the suite. */
  newTest: { file: string; contents: string };
}

export interface AdapterConformanceSpec {
  /** The adapter under test. */
  adapter: Adapter;
  /** Build the adapter's recorder for a fixture project. */
  createRecorder(init: { cwd: string; config: CovselConfig }): Recorder;
  fixture: ConformanceFixture;
  /**
   * Run a computed selection the way the adapter would. Optional: adapters that
   * only emit a file list are exercised through that list instead.
   */
  runSelection?(init: { selected: TestId[]; cwd: string }): number;
}

/** One conformance check's outcome. */
export interface ConformanceResult {
  check: string;
  ok: boolean;
  /** Why it failed, or what it observed when it passed. */
  detail: string;
}
