/**
 * What the fixture writes and the recorder reads.
 *
 * The two run in different processes — the recorder in covsel's, the fixture in
 * every Playwright worker — so this is the whole of what they agree on. It lives
 * in its own module because both import it, and because a change to it is a
 * change to a wire format: an older fixture left in a project's `node_modules`
 * meets a newer recorder, and the shape is what tells them apart.
 */
import type { CoveredBlock, CoveredFile } from '@covsel/core';

/** Directory the fixture appends its observations to, one file per worker. */
export const OUT_DIR_ENV = 'COVSEL_OUT';
/** The mapper's configuration, carried whole as JSON. */
export const CONFIG_ENV = 'COVSEL_CONFIG';
/** The repo root, so the worker maps against the same tree covsel discovered. */
export const CWD_ENV = 'COVSEL_CWD';
/** `'1'` when the recording wants block granularity. */
export const BLOCKS_ENV = 'COVSEL_BLOCKS';

/** What one observation window saw. */
export interface ObservedWindow {
  files: CoveredFile[];
  blocks: CoveredBlock[];
  /**
   * The repo paths this window was in a position to see run.
   *
   * Absent when there is only ever one window, which is the browser-only case:
   * the recorder's own declaration is then the whole truth and attaching a copy
   * of it here would only be a second place for it to drift. Present the moment a
   * second window exists, because the two see different halves of the repository
   * and a window claiming the other's paths would have a browser recording vouch
   * for the server.
   */
  observes?: readonly string[];
}

/** A window that produced nothing usable, and why. */
export interface FailedWindow {
  failed: string;
}

/** One test, as the fixture observed it. */
export interface ObservedTest {
  /** Repo-relative path of the spec file. */
  file: string;
  /**
   * The test's title path joined with spaces — file, describes, and title, in
   * the order Playwright's `--grep` matches them.
   *
   * Deliberately not the test's own title: `--grep` is applied to the whole
   * title, so this is what a selection has to name to reach exactly this test.
   * The project name is left off, because a name carrying one would select only
   * the browser the map was recorded on.
   */
  name: string;
  /** One per isolate observed. Phase 1 records the browser and nothing else. */
  windows: (ObservedWindow | FailedWindow)[];
  /** Scripts this test executed that the project accepted as unmappable. */
  allowedUnmappable: string[];
}
