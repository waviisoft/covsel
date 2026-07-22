/**
 * The on-disk coverage-map schema. This is a versioned, stable contract:
 * bumping MAP_SCHEMA_VERSION invalidates every stored map, which — per the
 * fail-open policy — forces a full test run with a clear log line.
 */

/** Bump on any breaking change to the persisted map shape. */
export const MAP_SCHEMA_VERSION = 1;

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

export type Granularity = 'file' | 'block' | 'line';

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
  entries: MapEntry[];
}

/**
 * Returns true when a stored map can be used for selection. A false result
 * must be treated as "run everything" (fail open), never "run nothing".
 */
export function isUsableMap(map: unknown): map is CoverageMap {
  if (typeof map !== 'object' || map === null) return false;
  const m = map as Partial<CoverageMap>;
  return m.schemaVersion === MAP_SCHEMA_VERSION && Array.isArray(m.entries);
}
