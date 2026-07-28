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
  /**
   * A change *inside a function body* of `source` that this unit executes, as a
   * literal substring and its replacement. Appending to a file only perturbs the
   * module skeleton, so without this the block-granularity path — the default —
   * is never exercised, and an adapter that records only module blocks looks
   * perfect while missing every change to a function.
   *
   * The suite rejects a `bodyEdit` that changes the module block or leaves every
   * function hash intact, so it cannot be satisfied by an edit that does not
   * reach a function body.
   */
  bodyEdit: { find: string; replace: string };
}

/**
 * Name of the file each unit appends its label to when it runs, relative to the
 * project root. The suite deletes it, hands the runner a selection, and reads it
 * back — that is how it sees which units a selection actually executed, without
 * parsing any runner's output format.
 */
export const RAN_MARKER_FILE = '.covsel-conformance-ran';

/**
 * A throwaway project the suite writes, records, and edits. It must contain two
 * units that execute different sources, so the suite can tell precise selection
 * from "everything ran", plus one source both reach *indirectly*, so it can tell
 * recording everything a unit touched from recording only what its test file
 * names.
 *
 * Every unit must append its label — its `name`, or its `testFile` when it has
 * no name — followed by a newline to {@link RAN_MARKER_FILE} when it runs.
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
  /**
   * A source file *both* units execute, reached only *through* their own
   * sources — no test file may import it. Editing it must select both.
   *
   * The indirection is the point. A recorder that credits a test with the files
   * its test file names, and nothing those files reach in turn, is precise,
   * deterministic, and fails open on new tests and sentinels; only a source it
   * had to follow a dependency to find will expose it. The suite rejects a
   * fixture whose test files mention this path, so it cannot be satisfied by a
   * source that is really a direct import.
   */
  sharedSource: string;
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
   * Run a computed selection the way the adapter would, returning the runner's
   * exit code. Optional: adapters that only emit a file list are exercised by
   * appending `formatSelection`'s output to `fixture.command` instead. Either
   * way the suite runs it and checks which units the runner actually executed.
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
