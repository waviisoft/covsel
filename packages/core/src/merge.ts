import {
  type CoverageMap,
  type CoveredBlock,
  type CoveredFile,
  isUsableMap,
  MAP_SCHEMA_VERSION,
  type MapEntry,
} from './schema.js';

function testKey(entry: MapEntry): string {
  return `${entry.test.file}\0${entry.test.name ?? ''}`;
}

/**
 * Combine shard maps into one, for CI runs that split the suite across jobs.
 *
 * Every ambiguity resolves toward selecting more later:
 *  - Entries union by test id, and an id seen in several shards unions its
 *    covered files and blocks.
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
        });
        continue;
      }
      const files = new Map<string, CoveredFile>();
      for (const f of [...existing.files, ...entry.files]) files.set(f.file, f);
      existing.files = [...files.values()].sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
      );
      const merged = [...(existing.blocks ?? []), ...(entry.blocks ?? [])];
      if (merged.length > 0) {
        const blocks = new Map<string, CoveredBlock>();
        for (const b of merged) blocks.set(`${b.file}\0${b.blockHash}`, b);
        existing.blocks = [...blocks.values()];
      }
    }
  }

  const entries = [...byTest.values()].sort((a, b) =>
    testKey(a) < testKey(b) ? -1 : testKey(a) > testKey(b) ? 1 : 0,
  );

  const allBlocks = usable.every((m) => m.granularity === 'block');
  const commits = new Set(usable.map((m) => m.commit));
  const commit = commits.size === 1 ? [...commits][0] : undefined;
  const recordedAt = usable
    .map((m) => m.recordedAt)
    .sort()
    .at(0)!;

  const sentinelHashes: Record<string, string> = {};
  for (const map of usable) Object.assign(sentinelHashes, map.sentinelHashes);

  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity: allBlocks ? 'block' : 'file',
    ...(commit ? { commit } : {}),
    recordedAt,
    sentinelHashes,
    entries,
  };
}
