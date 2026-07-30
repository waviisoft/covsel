/**
 * The on-disk coverage-map schema. This is a versioned, stable contract:
 * bumping MAP_SCHEMA_VERSION invalidates every stored map, which — per the
 * fail-open policy — forces a full test run with a clear log line.
 */

/** Bump on any breaking change to the persisted map shape. */
export const MAP_SCHEMA_VERSION = 2;

/**
 * Identifies a test at the finest granularity we know about.
 * Whole-file (process) mode: `file` only.
 * Per-test (inspector) mode: `file` + `name` (test title / scenario + line).
 */
export interface TestId {
  /** Test file path, repo-relative with forward slashes. */
  file: string;
  /** Full test name / cucumber scenario id, when per-test granularity is available. */
  name?: string;
}

/** A covered region of an *original* (post-source-map) source file. */
export interface CoveredBlock {
  /** Repo-relative path of the original source file. */
  file: string;
  /**
   * Content hash of the enclosing block (function/method body). Blocks are
   * fingerprinted by content, not line numbers, so the map survives
   * reformatting and line shifts.
   */
  blockHash: string;
}

/** File-level entry (granularity: "file"). */
export interface CoveredFile {
  file: string;
  /** Content hash of the whole file at record time. */
  fileHash: string;
}

/**
 * The granularities covsel records and selects at, and therefore the only ones
 * the map may name.
 *
 * There is no line granularity, and adding one would contradict the reason
 * blocks are hashed rather than numbered: line numbers do not survive
 * reformatting, so a line-keyed map goes stale on a change that alters no
 * behaviour at all. Wanting finer resolution than a whole function is an
 * argument for smaller blocks, not for line numbers.
 */
export const GRANULARITIES = Object.freeze(['file', 'block'] as const);

export type Granularity = (typeof GRANULARITIES)[number];

/** True when a value is a granularity this covsel can record and select at. */
export function isGranularity(value: unknown): value is Granularity {
  return (GRANULARITIES as readonly unknown[]).includes(value);
}

/** One test's footprint in the map. */
export interface MapEntry {
  test: TestId;
  files: CoveredFile[];
  blocks?: CoveredBlock[];
}

/** The persisted map. */
export interface CoverageMap {
  schemaVersion: typeof MAP_SCHEMA_VERSION;
  /** Granularity the map was recorded at. */
  granularity: Granularity;
  /** Commit the map was recorded against, if known. */
  commit?: string;
  /** ISO timestamp of the recording run. */
  recordedAt: string;
  /** Hashes of sentinel files at record time; any change invalidates the map. */
  sentinelHashes: Record<string, string>;
  /**
   * Repo-relative globs the recording was able to observe execution within.
   *
   * The entries say which files each test covered. They cannot, on their own,
   * say whether "not covered" means "did not run" or "ran somewhere the
   * recorder could not see" — and selection reads it the first way. This is
   * what separates the two: outside these globs the map's silence carries no
   * information, so a change there falls open to a full run rather than
   * selecting on coverage that was never in a position to see it.
   *
   * A recorder whose runner executes the code under test in the process tree
   * the recorder controls sees any path that runs, and declares `['**']`. One
   * that sees only part of a test's execution declares only what it can see,
   * and is then held to it.
   */
  observed: string[];
  entries: MapEntry[];
}

/**
 * The `observed` scope of a recorder that would see any repo path that ran —
 * every recorder whose runner executes the code under test in the process tree
 * the recorder controls.
 */
export const OBSERVES_EVERYTHING: readonly string[] = Object.freeze(['**']);

/**
 * Returns true when a stored map can be used for selection. A false result
 * must be treated as "run everything" (fail open), never "run nothing".
 */
export function isUsableMap(map: unknown): map is CoverageMap {
  if (typeof map !== 'object' || map === null) return false;
  const m = map as Partial<CoverageMap>;
  if (m.schemaVersion !== MAP_SCHEMA_VERSION || !Array.isArray(m.entries)) return false;
  // A granularity covsel cannot record at says the entries were measured by
  // something this build does not understand, so what they credit — and what
  // their silence means — is unknown. Rejecting is the reading that cannot skip
  // a test whatever a later reader does with the value: a check spelled
  // `=== 'block'` would degrade it to whole-file, and one spelled `!== 'file'`
  // would select by blocks the entries may not carry. The map never has to be
  // read for that to be decided.
  if (!isGranularity(m.granularity)) return false;
  // A map that does not say what it could observe cannot be told apart from one
  // that observed everything, and guessing "everything" is the guess that skips
  // tests. Require the declaration, and treat its absence as unusable.
  return Array.isArray(m.observed) && m.observed.every((g) => typeof g === 'string');
}
