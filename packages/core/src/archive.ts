import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import type { CovselConfig } from './config.js';
import { commitExists, isAncestorCommit } from './git.js';
import { type CoverageMap, isUsableMap } from './schema.js';
import { LocalStore } from './store.js';

/**
 * The archive: maps kept by the commit each was recorded on, so a later checkout
 * can pick the one it is able to measure change from.
 *
 * A CI job does not record its own map — that is the whole point of recording on
 * the default branch — so it has to be handed one. Handing it *the newest* map
 * is the obvious thing and the wrong thing: the newest map was recorded on
 * whatever commit was current when it was written, which may be a commit this
 * checkout has never heard of (another branch, a force-push, a pruned history).
 * Selection then falls open to a full run, which is safe and wastes exactly the
 * minutes covsel was installed to save — while an older map recorded on an
 * ancestor of `HEAD`, sitting in the same archive, would have selected.
 *
 * So the archive keeps several, and choosing between them is the interesting
 * part. Transport is not: an archive is a directory, and CI already knows how to
 * carry a directory between jobs.
 */

/** Maps kept per archive before the oldest are pruned. */
export const DEFAULT_ARCHIVE_KEEP = 20;

/**
 * Where a project's archive lives. `store.archiveDir` is read relative to the
 * store directory, so the default sits inside it and whatever a CI job already
 * caches to carry `.covsel` between runs carries the archive too. An absolute
 * setting wins, for an archive on a shared volume.
 */
export function archiveDirFor(cwd: string, config: Pick<CovselConfig, 'store'>): string {
  return resolve(join(cwd, config.store.dir), config.store.archiveDir);
}

/**
 * A commit as a file name. Validated rather than trusted: the commit is read out
 * of a JSON map, and a hand-edited one naming `../../etc/whatever` must not
 * decide where covsel writes. Short and long hashes are both accepted, since a
 * map may have been written by a tool that abbreviated.
 */
const COMMIT = /^[0-9a-f]{7,64}$/i;

/**
 * An archived map's file name: when it was recorded, then the commit it records.
 *
 * Both facts are in the name so that listing an archive needs no file reads at
 * all. That is not micro-optimisation: covsel's own map is over half a megabyte
 * for a small repository, and a monorepo's is far larger, so parsing every
 * candidate to recover two fields would mean reading hundreds of megabytes before
 * a single test runs. It also means every correctly-named file is listed whatever
 * its contents, so nothing can hide from pruning by being unreadable.
 *
 * The stamp is fixed-width milliseconds so the names sort chronologically as
 * strings, and wide enough not to overflow for the next few thousand years.
 */
const NAME = /^(\d{15})-([0-9a-f]{7,64})\.json$/i;
const STAMP_WIDTH = 15;

function archiveName(commit: string, recordedAt: string): string {
  return `${String(instant(recordedAt)).padStart(STAMP_WIDTH, '0')}-${commit}.json`;
}

/** One map in an archive, as its file name describes it. */
export interface ArchivedMap {
  /** The commit the map records. */
  commit: string;
  /** When it was recorded, as an ISO instant is not recoverable from the name. */
  recordedAtMs: number;
  /** Absolute path of the map file. */
  file: string;
}

/**
 * Every archived map, newest first, read from file names alone.
 *
 * Names that are not an archive's are ignored — the directory may be shared with
 * something else, and covsel does not own files it did not write. Ties on the
 * recorded instant break by commit, so the choice is stable across jobs.
 *
 * Nothing here says whether a map is *usable*; that needs the contents, and is
 * settled when one is actually chosen. Listing deliberately does not care, so an
 * unreadable or wrong-schema map still occupies a slot and still ages out.
 */
export function listArchive(dir: string): ArchivedMap[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: ArchivedMap[] = [];
  for (const name of names) {
    const match = NAME.exec(name);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    found.push({
      commit: match[2],
      recordedAtMs: Number(match[1]),
      file: join(dir, name),
    });
  }
  return found.sort(byNewest);
}

/** Newest first by recorded instant, then by commit so ordering is total. */
function byNewest(a: ArchivedMap, b: ArchivedMap): number {
  if (a.recordedAtMs !== b.recordedAtMs) return b.recordedAtMs - a.recordedAtMs;
  return a.commit < b.commit ? -1 : a.commit > b.commit ? 1 : 0;
}

function instant(recordedAt: string | undefined): number {
  if (recordedAt === undefined) return 0;
  const parsed = Date.parse(recordedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Read an archived map, or `undefined` when it is not one this checkout can use.
 *
 * The commit in the name is what the archive is addressed by, so a map whose own
 * commit disagrees with it is rejected: ancestry would otherwise be tested against
 * one commit and the diff taken from another, which is how a map ends up trusted
 * for a tree it never described.
 */
export function readArchivedMap(entry: ArchivedMap): CoverageMap | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(entry.file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isUsableMap(parsed)) return undefined;
  if (parsed.commit !== entry.commit) return undefined;
  return parsed;
}

export interface PublishInit {
  /** The archive directory, absolute or already resolved by the caller. */
  dir: string;
  /** The map to publish. */
  map: CoverageMap;
  /** Maps to keep, oldest pruned first. Defaults to {@link DEFAULT_ARCHIVE_KEEP}. */
  keep?: number;
}

export type PublishResult =
  | {
      ok: true;
      commit: string;
      file: string;
      /** Commits removed to stay within `keep`. */
      pruned: string[];
    }
  | { ok: false; reason: string };

/**
 * Add a map to an archive under the commit it records.
 *
 * A map that names no commit is refused. Such a map is not a map of anything a
 * later checkout can find: selection cannot measure change from it, and every
 * job that fetched it would fall open. Refusing here means the failure is
 * reported once, by the job that recorded it, rather than silently on every
 * pull request afterwards.
 *
 * Publishing the same commit twice replaces it, so re-recording a commit
 * supersedes the older reading instead of accumulating two answers for one tree.
 */
export function publishMap(init: PublishInit): PublishResult {
  const { dir, map } = init;
  const keep = Math.max(1, init.keep ?? DEFAULT_ARCHIVE_KEEP);
  if (!isUsableMap(map)) {
    return { ok: false, reason: 'the map is not usable (wrong schema version?)' };
  }
  if (map.commit === undefined) {
    return {
      ok: false,
      reason:
        'the map records no commit, so nothing could measure change from it. ' +
        'Record from a clean checkout of a committed tree, then publish',
    };
  }
  if (!COMMIT.test(map.commit)) {
    return { ok: false, reason: `'${map.commit}' is not a commit hash` };
  }

  mkdirSync(dir, { recursive: true });
  // Re-recording a commit supersedes the older reading rather than accumulating
  // two answers for one tree. The name carries the recorded instant, so the
  // previous file for this commit has a different name and has to be removed by
  // commit rather than overwritten by path.
  for (const existing of listArchive(dir)) {
    if (existing.commit !== map.commit) continue;
    try {
      rmSync(existing.file);
    } catch {
      /* a file that will not go is not a failed publish */
    }
  }

  const file = join(dir, archiveName(map.commit, map.recordedAt));
  // Formatted exactly as the local store writes a map, so an archived map is
  // byte-identical to the one `covsel record` produced.
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);

  // Prune after writing: the map just published is the one that must survive,
  // and counting it in means a `keep` of 1 keeps it rather than the previous one.
  //
  // Listing is name-based, so every archived file is a candidate whatever its
  // contents. That matters after a schema bump, which makes every stored map
  // unusable at once: judged by usability they would all be invisible here and
  // would sit in the archive — and in every cache entry copied from it — forever.
  const pruned: string[] = [];
  for (const stale of listArchive(dir).slice(keep)) {
    try {
      rmSync(stale.file);
      pruned.push(stale.commit);
    } catch {
      // A file that cannot be removed is a full archive, not a failed publish.
    }
  }
  return { ok: true, commit: map.commit, file, pruned };
}

/** Why an archived map was passed over. */
export interface SkippedMap {
  commit: string;
  reason: string;
}

/** What choosing a map from an archive settled on. */
export type MapChoice =
  | {
      kind: 'chosen';
      map: ArchivedMap;
      /** `ancestor` diffs tightly; `present` is safe but over-selects. */
      how: 'ancestor' | 'present';
      skipped: SkippedMap[];
    }
  | { kind: 'none'; skipped: SkippedMap[] };

/** What the checkout can say about a commit. */
export interface CommitChecks {
  /** True when this checkout has the commit at all. */
  has(commit: string): boolean;
  /** True when the commit is an ancestor of `HEAD`. */
  isAncestor(commit: string): boolean;
}

/**
 * Choose the map a checkout should select against, from an archive listed newest
 * first.
 *
 * Two tiers, and the difference between them is precision rather than safety:
 *
 *  - **An ancestor of `HEAD`** is the tight case, and the one CI hits: the diff
 *    from it to `HEAD` is this branch's own work plus whatever landed on the
 *    default branch in between, and nothing else.
 *  - **A commit this checkout merely has** still yields a sound selection.
 *    Selection diffs a map's commit to `HEAD` exactly — tree against tree, never
 *    through a merge-base — so every file that differs in either direction is
 *    accounted for. It just diffs more of them, because the two trees diverged.
 *    Over-selection, which is the safe direction, and strictly better than the
 *    full run that choosing nothing would cause.
 *
 * A commit the checkout does not have is unusable: nothing can be diffed from a
 * commit git cannot resolve. That is the shallow-clone case, and the reason
 * `fetch-depth: 0` is in the CI guide.
 */
export function chooseArchivedMap(
  candidates: readonly ArchivedMap[],
  checks: CommitChecks,
): MapChoice {
  const skipped: SkippedMap[] = [];
  const present: ArchivedMap[] = [];
  for (const candidate of candidates) {
    if (!checks.has(candidate.commit)) {
      skipped.push({
        commit: candidate.commit,
        reason: 'not in this checkout (fetch more history?)',
      });
      continue;
    }
    if (checks.isAncestor(candidate.commit)) {
      return { kind: 'chosen', map: candidate, how: 'ancestor', skipped };
    }
    present.push(candidate);
  }
  // No ancestor. The newest commit the checkout does have is next best, and the
  // candidates arrive newest first, so the first one is it.
  const fallback = present[0];
  if (fallback !== undefined) {
    for (const other of present) {
      if (other !== fallback) {
        skipped.push({ commit: other.commit, reason: 'an older diverged commit' });
      }
    }
    return { kind: 'chosen', map: fallback, how: 'present', skipped };
  }
  for (const candidate of present) {
    skipped.push({ commit: candidate.commit, reason: 'not an ancestor of HEAD' });
  }
  return { kind: 'none', skipped };
}

/** Commit checks against a real git work tree. */
export function gitCommitChecks(cwd: string): CommitChecks {
  // Both answers are asked for once per candidate at most, and an archive is
  // bounded by `keep`, so memoizing keeps the git calls proportional to the
  // maps actually considered rather than to how often they are consulted.
  const has = new Map<string, boolean>();
  const ancestor = new Map<string, boolean>();
  return {
    has(commit) {
      const cached = has.get(commit);
      if (cached !== undefined) return cached;
      const answer = commitExists(cwd, commit);
      has.set(commit, answer);
      return answer;
    },
    isAncestor(commit) {
      const cached = ancestor.get(commit);
      if (cached !== undefined) return cached;
      const answer = isAncestorCommit(cwd, commit);
      ancestor.set(commit, answer);
      return answer;
    },
  };
}

export interface FetchInit {
  cwd: string;
  /** The archive directory. */
  dir: string;
  /** Where the fetched map is installed. */
  storeDir: string;
  /** Overwrite a local map that is newer than the fetched one. */
  force?: boolean;
  /** Commit checks; defaults to real git in `cwd`. */
  checks?: CommitChecks;
}

export type FetchResult =
  | {
      ok: true;
      commit: string;
      how: 'ancestor' | 'present';
      /** Where the map was installed. */
      mapPath: string;
      /** The instant the chosen map records, as it records it. */
      recordedAt: string;
      skipped: SkippedMap[];
    }
  | { ok: false; reason: string; skipped: SkippedMap[] };

/**
 * Install the best archived map as this checkout's local map.
 *
 * Finding nothing is not an error: a job whose archive is empty, stale, or too
 * shallow to use must still run its tests, and covsel's answer to "no usable
 * map" has always been a full run. The caller decides whether that is worth a
 * non-zero exit.
 */
export async function fetchMap(init: FetchInit): Promise<FetchResult> {
  const { cwd, dir, storeDir } = init;
  const checks = init.checks ?? gitCommitChecks(cwd);
  const store = new LocalStore({ cwd, dir: storeDir });
  let remaining = listArchive(dir);
  if (remaining.length === 0) {
    return {
      ok: false,
      reason: existsSync(dir)
        ? `no archived map in ${dir}`
        : `no archive at ${dir} (nothing has been published yet?)`,
      skipped: [],
    };
  }

  // Listing reads names, not contents, so whether a chosen map is *usable* is
  // only known once it is opened. An unusable one is dropped and the choice
  // retried over what is left, rather than failing the fetch — a single map left
  // behind by an older schema must not cost a job the newer ones that follow it.
  const skipped: SkippedMap[] = [];
  for (;;) {
    const choice = chooseArchivedMap(remaining, checks);
    if (choice.kind === 'none') {
      return {
        ok: false,
        reason: `no map in ${dir} records a commit this checkout can measure change from`,
        skipped: [...skipped, ...choice.skipped],
      };
    }

    const map = readArchivedMap(choice.map);
    if (map === undefined) {
      skipped.push({
        commit: choice.map.commit,
        reason: 'not a usable map (recorded by a different covsel version?)',
      });
      remaining = remaining.filter((entry) => entry !== choice.map);
      continue;
    }

    // A developer who recorded locally has a map describing their own tree, which
    // is better than anything an archive holds. Refusing to overwrite it keeps
    // `fetch` from quietly undoing a recording, and CI never hits this because a
    // fresh checkout has no local map.
    if (init.force !== true) {
      const local = await store.read();
      if (local !== undefined && instant(local.recordedAt) > instant(map.recordedAt)) {
        return {
          ok: false,
          reason:
            `the local map at ${store.path()} was recorded more recently than ` +
            `${choice.map.commit}; pass --force to replace it`,
          skipped: [...skipped, ...choice.skipped],
        };
      }
    }

    await store.write(map);
    return {
      ok: true,
      commit: choice.map.commit,
      how: choice.how,
      mapPath: store.path(),
      recordedAt: map.recordedAt,
      skipped: [...skipped, ...choice.skipped],
    };
  }
}
