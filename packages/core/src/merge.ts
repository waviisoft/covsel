import { agreedScope } from './combine.js';
import { changedConfigFields, type RecordedConfig } from './config.js';
import {
  type CoverageMap,
  type CoveredBlock,
  type CoveredFile,
  isUsableMap,
  MAP_SCHEMA_VERSION,
  type MapDependencies,
  type MapEntry,
} from './schema.js';

function testKey(entry: MapEntry): string {
  return `${entry.test.file}\0${entry.test.name ?? ''}`;
}

/**
 * Order two keys, stably and without locale rules. A merged map is compared
 * byte for byte across shards and across runs, so its ordering has to come from
 * the strings themselves rather than from whatever collation the host has.
 */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The installed tree every shard agrees it recorded against, if there is one.
 *
 * The analogue of {@link agreedScope}, and safe for the same reason: a smaller
 * inventory falls open more. Any shard without dependencies drops them for the
 * whole merge — its entries say nothing about packages, and the merged map
 * claims one set of dependencies for every entry in it.
 *
 * Shards whose markers disagree installed different trees. Their entries then
 * describe different resolutions of the same names, and a merged inventory
 * would vouch for a package at a version half the entries never ran.
 */
/**
 * The configuration every shard agrees it recorded under, if there is one.
 *
 * A merged map claims one configuration for every entry in it, and shards that
 * disagree have no single answer to make that claim with: one shard's entries
 * were measured under `sourceGlobs` the other's were not, and a merged map
 * naming either would vouch for entries recorded under the other. A shard with
 * no recorded configuration says nothing about its own, which is the same
 * absence.
 *
 * Dropping it costs a full run on the next config change, which is what a map
 * without one gets anyway.
 */
function agreedConfig(maps: CoverageMap[]): RecordedConfig | undefined {
  const first = maps[0]?.config;
  if (first === undefined) return undefined;
  const identical = maps.every(
    (m) => m.config !== undefined && changedConfigFields(first, m.config).length === 0,
  );
  return identical ? first : undefined;
}

function agreedDependencies(maps: CoverageMap[]): MapDependencies | undefined {
  const first = maps[0]?.dependencies;
  if (first === undefined) return undefined;
  const identical = maps.every(
    (m) =>
      m.dependencies?.manager === first.manager &&
      m.dependencies.marker === first.marker &&
      m.dependencies.markerHash === first.markerHash,
  );
  if (!identical) return undefined;

  // Equal markers should mean equal inventories, but the intersection is what
  // makes that a fact rather than an assumption: a name any shard did not see,
  // or saw at other versions, is dropped and falls open.
  const key = (versions: string[]): string => versions.join('\0');
  const inventory: Record<string, string[]> = {};
  for (const [name, versions] of Object.entries(first.inventory)) {
    const shared = maps.every((m) => {
      const other = m.dependencies?.inventory[name];
      return other !== undefined && key(other) === key(versions);
    });
    if (shared) inventory[name] = [...versions];
  }
  return {
    manager: first.manager,
    marker: first.marker,
    markerHash: first.markerHash,
    inventory,
  };
}

/**
 * Combine shard maps into one, for CI runs that split the suite across jobs.
 *
 * Every ambiguity resolves toward selecting more later:
 *  - Entries union by test id, and an id seen in several shards unions its
 *    covered files and blocks — unless one of them credits no file at all, which
 *    is a shard saying it could not see where the test ran rather than one
 *    measuring it covering nothing. The merged entry then credits nothing too,
 *    and selection runs it.
 *  - Granularity drops to `file` unless every contributing map recorded blocks;
 *    a map that is only partly block-aware must not narrow selection by blocks.
 *  - `recordedAt` is the oldest shard's, because the result is only as fresh as
 *    its stalest part.
 *  - `commit` survives only when every shard agrees. Shards that ran at
 *    different commits describe different trees, so the merged map has no single
 *    point to measure change from, and selection treats that as untrustworthy.
 *
 * Throws when there is nothing usable to merge — callers must treat that as
 * "run everything", never as an empty map.
 */
export function mergeMaps(maps: CoverageMap[]): CoverageMap {
  const usable = maps.filter((m): m is CoverageMap => isUsableMap(m));
  if (usable.length === 0) throw new Error('no usable maps to merge');

  const byTest = new Map<string, MapEntry>();
  for (const map of usable) {
    for (const entry of map.entries) {
      const key = testKey(entry);
      const existing = byTest.get(key);
      if (!existing) {
        byTest.set(key, {
          test: entry.test,
          files: [...entry.files],
          ...(entry.blocks ? { blocks: [...entry.blocks] } : {}),
          ...(entry.packages !== undefined ? { packages: [...entry.packages] } : {}),
        });
        continue;
      }
      // Packages behave like blocks and for the same reason: a shard that
      // recorded none for this test knows nothing about which packages it ran,
      // and keeping the other's list would let a bump to a package only this
      // shard's run executed miss the entry.
      if (existing.packages === undefined || entry.packages === undefined) {
        delete existing.packages;
      } else {
        existing.packages = [...new Set([...existing.packages, ...entry.packages])].sort(
          byKey,
        );
      }
      // Files carry an unknown state of their own, and it is the empty list: a
      // shard that credits a test with nothing did not measure it covering
      // nothing, it failed to see where the test ran. Unioning that with a
      // shard that saw something yields an entry claiming exactly what the
      // seeing shard saw — a claim neither shard made, and one that reads as a
      // measurement, so everything the blind shard's run executed is skipped on
      // a map that looks healthy. Selection runs an entry crediting nothing, so
      // keeping it empty is what carries the doubt across the merge.
      if (existing.files.length === 0 || entry.files.length === 0) {
        existing.files = [];
      } else {
        const files = new Map<string, CoveredFile>();
        for (const f of [...existing.files, ...entry.files]) files.set(f.file, f);
        existing.files = [...files.values()].sort((a, b) => byKey(a.file, b.file));
      }
      // Blocks narrow selection, so they may only survive when both sides know
      // them. If either shard recorded none for this test, its coverage of the
      // test is unknown at block level and the entry falls back to file level.
      if (existing.blocks === undefined || entry.blocks === undefined) {
        delete existing.blocks;
      } else {
        const blocks = new Map<string, CoveredBlock>();
        for (const b of [...existing.blocks, ...entry.blocks]) {
          blocks.set(`${b.file}\0${b.blockHash}`, b);
        }
        existing.blocks = [...blocks.values()];
      }
    }
  }

  const entries = [...byTest.values()].sort((a, b) => byKey(testKey(a), testKey(b)));

  // A shard's silence is only informative inside its own observed scope, so the
  // merged map may claim no more than every shard agreed on.
  const observed = agreedScope(usable.map((m) => m.observed));

  const allBlocks = usable.every((m) => m.granularity === 'block');
  const commits = new Set(usable.map((m) => m.commit));
  const commit = commits.size === 1 ? [...commits][0] : undefined;
  // Compare as instants, not strings: `recordedAt` is only conventionally an
  // ISO-8601 UTC stamp, and an offset form would sort wrong lexicographically.
  const stamps = usable
    .map((m) => m.recordedAt)
    .filter((s): s is string => typeof s === 'string' && !Number.isNaN(Date.parse(s)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const recordedAt = stamps[0] ?? new Date().toISOString();

  // Sentinel hashes only feed the drift report in `status`; the full-run trigger
  // is a sentinel path showing up in the diff, so a conflict here cannot affect
  // selection. Later shards win.
  const sentinelHashes: Record<string, string> = {};
  for (const map of usable) Object.assign(sentinelHashes, map.sentinelHashes);

  const config = agreedConfig(usable);

  // An inventory is only meaningful when every entry says which packages it
  // ran: one that does not would be read as a test running no vendored code,
  // and every dependency it really uses would go unselected on a bump. Keeping
  // the two in step is what lets selection rely on the pairing.
  // `every` on an empty list is vacuously true, and an inventory beside no
  // entries would say every package was installed and ran nowhere.
  const everyEntryHasPackages =
    entries.length > 0 && entries.every((e) => e.packages !== undefined);
  const dependencies = everyEntryHasPackages ? agreedDependencies(usable) : undefined;

  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity: allBlocks ? 'block' : 'file',
    ...(commit ? { commit } : {}),
    recordedAt,
    sentinelHashes,
    ...(config ? { config } : {}),
    observed,
    ...(dependencies ? { dependencies } : {}),
    entries,
  };
}
