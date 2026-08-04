import type { RecordedConfig } from './config.js';

/**
 * The on-disk coverage-map schema. This is a versioned, stable contract:
 * bumping MAP_SCHEMA_VERSION invalidates every stored map, which — per the
 * fail-open policy — forces a full test run with a clear log line.
 */

/**
 * Bump on any breaking change to the persisted map shape.
 *
 * A change to how block hashes are computed is one of those, even when no field
 * moves: every recorded hash stops matching the same code, so the entries credit
 * blocks that no longer exist. Rejecting such a map is what turns that into a
 * full run instead of a selection made against hashes nothing can match.
 */
export const MAP_SCHEMA_VERSION = 4;

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
  /**
   * Names of the installed packages this test executed code in, sorted.
   *
   * Present on every entry of a map recorded by a package-observing recorder,
   * or on none — an empty array is a test that ran no vendored code, which is a
   * measurement, while absence means the recorder never watched for it and
   * nothing may be concluded. Selection needs `dependencies` as well, since a
   * package list is only meaningful against a known, provably current install.
   */
  packages?: string[];
}

/**
 * What was installed when the map was recorded, and the proof the install was
 * current — the "before" side a later dependency change is measured against.
 *
 * Absent means fall open: covsel could not observe packages, could not identify
 * the package manager, or the map predates this being recorded at all. Since
 * every existing map is in exactly that position, absence has to keep meaning
 * today's behaviour, which is a full run on any lockfile change.
 */
export interface MapDependencies {
  /** The package manager whose installed tree this describes. */
  manager: string;
  /** Repo-relative path of that manager's install marker. */
  marker: string;
  /**
   * Content hash of the marker at record time.
   *
   * A lockfile pulled without an install is the case this catches: the tree
   * would show no difference from the inventory, and "nothing changed" computed
   * against a stale install is the answer that skips tests. The marker is the
   * only sound freshness check, because a tree stale for one reason can still
   * differ for another and hide the change.
   */
  markerHash: string;
  /**
   * Every installed package the recorder could have observed executing, and the
   * versions it was installed at.
   *
   * The distinction this exists for: a changed package *in* here that no entry
   * mentions was watched and never ran, so nothing need be selected for it,
   * while a changed package *absent* from here is one the map never had an
   * opinion about, and falls open. Without it the two are indistinguishable and
   * everything falls open.
   */
  inventory: Record<string, string[]>;
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
   * The configuration this was recorded under, restricted to the fields whose
   * values shape what the map means.
   *
   * A map is meaningful only under the configuration it was recorded with, and
   * this is what lets a later run ask whether that configuration actually
   * moved. Without it the only available question is whether the config *file*
   * appears in the diff, which answers yes to a reworded comment and no to a
   * value that changed for a reason the diff cannot show.
   *
   * Absent means fall open: a map recorded before this was written, or merged
   * from shards that disagreed about their configuration, has no recorded
   * configuration to compare against, and any change to a config file keeps
   * forcing the full run it forces today.
   */
  config?: RecordedConfig;
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
  /**
   * The installed tree this was recorded against, when the recorder could see
   * what packages a test executed and the package manager left a freshness
   * proof. Absent means every dependency change falls open.
   */
  dependencies?: MapDependencies;
  entries: MapEntry[];
}

/**
 * The `observed` scope of a recorder that would see any repo path that ran —
 * every recorder whose runner executes the code under test in the process tree
 * the recorder controls.
 */
export const OBSERVES_EVERYTHING: readonly string[] = Object.freeze(['**']);

/**
 * Why a stored value cannot be used for selection, or `undefined` when it can.
 *
 * Selection must not care which of these is true — an unusable map runs
 * everything however it got that way — so the reason is for the commands that
 * explain covsel to a human. It lives here, and `isUsableMap` is defined in
 * terms of it, so there is exactly one place that decides usability: a second
 * predicate written to produce these strings could drift, and the direction it
 * would drift in is the one that skips tests.
 */
export function mapRejection(map: unknown): string | undefined {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return 'the file does not hold a JSON object';
  }
  const m = map as Partial<CoverageMap>;
  if (m.schemaVersion !== MAP_SCHEMA_VERSION) {
    const found =
      typeof m.schemaVersion === 'number'
        ? `schema v${m.schemaVersion}`
        : 'no schema version';
    return `${found}, covsel reads v${MAP_SCHEMA_VERSION} -- re-record`;
  }
  if (!Array.isArray(m.entries)) return 'it records no entries list';
  // A granularity covsel cannot record at says the entries were measured by
  // something this build does not understand, so what they credit — and what
  // their silence means — is unknown. Rejecting is the reading that cannot skip
  // a test whatever a later reader does with the value: a check spelled
  // `=== 'block'` would degrade it to whole-file, and one spelled `!== 'file'`
  // would select by blocks the entries may not carry. The map never has to be
  // read for that to be decided.
  if (!isGranularity(m.granularity)) {
    return `it was recorded at ${JSON.stringify(m.granularity)} granularity, which covsel does not record at`;
  }
  // A map that does not say what it could observe cannot be told apart from one
  // that observed everything, and guessing "everything" is the guess that skips
  // tests. Require the declaration, and treat its absence as unusable.
  if (!Array.isArray(m.observed) || !m.observed.every((g) => typeof g === 'string')) {
    return 'it does not say what the recording could observe';
  }
  return undefined;
}

/**
 * Returns true when a stored map can be used for selection. A false result
 * must be treated as "run everything" (fail open), never "run nothing".
 */
export function isUsableMap(map: unknown): map is CoverageMap {
  return mapRejection(map) === undefined;
}
