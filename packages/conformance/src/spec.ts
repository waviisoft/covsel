import type { Adapter, CovselConfig } from '@covsel/core';

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
 * Code the fixture's units execute that a recorder is not necessarily in a
 * position to see — the app server a browser test drives, an isolate the runner
 * starts on its own. It is ordinary code to a recorder that observes everything
 * its runner executes, and a blind spot to one that does not; the suite reads it
 * as whichever the adapter's declared scope makes it.
 *
 * Supplying one is what lets the suite hold a partial declaration to something:
 * a fixture whose units execute only code the recorder can see never exercises
 * the declaration at all, and a recorder blind past it certifies green.
 */
export interface ConformanceBlindSpot {
  /**
   * The source, repo-relative and among the fixture's `files`. It must be code —
   * not a test file, and not a sentinel — because a change to either forces a
   * full run whatever the recording observed, and could never show that the
   * declared scope was what caused one.
   */
  source: string;
  /**
   * A change to `source` that makes *both* units fail, as a literal substring
   * and its replacement. The suite applies it and runs the units: a run that
   * still passes proves they do not really execute this code, and the fixture is
   * rejected rather than certifying a blind spot nothing reaches.
   */
  breakingEdit: { find: string; replace: string };
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
  /**
   * Config overrides for the fixture project. An adapter whose tests are not
   * `*.test.*` sources needs none: its own `defaultTestGlobs` are applied here
   * the same way the CLI applies them.
   */
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
  /**
   * Code both units execute that a recorder may not be able to observe.
   *
   * Required of a fixture used with an adapter whose declared scope does not
   * cover the whole fixture: without it the declaration is never exercised, and
   * a recorder that sees a fraction of the run reports what a complete one does.
   * An adapter that observes everything its runner executes needs none — nothing
   * lies outside `**` — and the suite then treats a supplied one as a source
   * like any other, which the recorder is held to having recorded.
   */
  blindSpot?: ConformanceBlindSpot;
  /** A test file that does not exist at record time, added later by the suite. */
  newTest: { file: string; contents: string };
}

/**
 * What the suite needs to certify an adapter: the adapter itself, and a project
 * to exercise it on. Everything the suite does to the runner — building the
 * recorder, running a selection — it asks the adapter object for, so an adapter
 * cannot pass here through a path the CLI does not take.
 */
export interface AdapterConformanceSpec {
  /** The adapter under test, exactly as its package exports it. */
  adapter: Adapter;
  fixture: ConformanceFixture;
}

/** One conformance check's outcome. */
export interface ConformanceResult {
  check: string;
  ok: boolean;
  /** Why it failed, or what it observed when it passed. */
  detail: string;
}
