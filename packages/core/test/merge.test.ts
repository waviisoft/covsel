import { describe, expect, it } from 'vitest';

import {
  type CoverageMap,
  type CovselConfigInput,
  MAP_SCHEMA_VERSION,
  mergeMaps,
  recordedConfig,
  resolveConfig,
} from '../src/index.js';

/** The configuration a shard would have recorded, from the values it was given. */
const recorded = (input: CovselConfigInput) => recordedConfig(resolveConfig(input));

function shard(over: Partial<CoverageMap> = {}): CoverageMap {
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity: 'file',
    commit: 'abc123',
    recordedAt: '2026-02-01T00:00:00.000Z',
    sentinelHashes: {},
    observed: ['**'],
    entries: [],
    ...over,
  };
}

const entry = (file: string, sources: string[], name?: string) => ({
  test: name === undefined ? { file } : { file, name },
  files: sources.map((s) => ({ file: s, fileHash: `sha256:${s}` })),
});

describe('mergeMaps', () => {
  it('unions entries from every shard', () => {
    const merged = mergeMaps([
      shard({ entries: [entry('a.test.ts', ['src/a.ts'])] }),
      shard({ entries: [entry('b.test.ts', ['src/b.ts'])] }),
    ]);
    expect(merged.entries.map((e) => e.test.file)).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('unions the covered files of a test recorded in several shards', () => {
    const merged = mergeMaps([
      shard({ entries: [entry('a.test.ts', ['src/a.ts'])] }),
      shard({ entries: [entry('a.test.ts', ['src/shared.ts'])] }),
    ]);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]!.files.map((f) => f.file)).toEqual([
      'src/a.ts',
      'src/shared.ts',
    ]);
  });

  it('keeps per-test entries of the same file distinct', () => {
    const merged = mergeMaps([
      shard({ entries: [entry('a.test.ts', ['src/a.ts'], 'one')] }),
      shard({ entries: [entry('a.test.ts', ['src/b.ts'], 'two')] }),
    ]);
    expect(merged.entries).toHaveLength(2);
  });

  it('keeps block granularity only when every shard has it', () => {
    const blocky = shard({
      granularity: 'block',
      entries: [{ ...entry('a.test.ts', ['src/a.ts']), blocks: [] }],
    });
    expect(mergeMaps([blocky, blocky]).granularity).toBe('block');
    expect(mergeMaps([blocky, shard()]).granularity).toBe('file');
  });

  it('unions blocks for a test seen in several shards', () => {
    const withBlock = (hash: string) =>
      shard({
        granularity: 'block',
        entries: [
          {
            ...entry('a.test.ts', ['src/a.ts']),
            blocks: [{ file: 'src/a.ts', blockHash: hash }],
          },
        ],
      });
    const merged = mergeMaps([withBlock('h1'), withBlock('h2')]);
    expect(merged.entries[0]!.blocks?.map((b) => b.blockHash).sort()).toEqual([
      'h1',
      'h2',
    ]);
  });

  it('drops blocks for a test when one shard recorded none, so merging cannot narrow selection', () => {
    // The shard without blocks knows nothing at block level for this test;
    // keeping only the other shard's blocks would filter out changes it covers.
    const withBlocks = shard({
      granularity: 'block',
      entries: [
        {
          ...entry('a.test.ts', ['src/x.ts']),
          blocks: [{ file: 'src/x.ts', blockHash: 'b1' }],
        },
      ],
    });
    const withoutBlocks = shard({
      granularity: 'block',
      entries: [entry('a.test.ts', ['src/x.ts'])],
    });
    expect(mergeMaps([withBlocks, withoutBlocks]).entries[0]!.blocks).toBeUndefined();
    expect(mergeMaps([withoutBlocks, withBlocks]).entries[0]!.blocks).toBeUndefined();
  });

  it('reports the oldest recordedAt, since the result is only as fresh as its stalest shard', () => {
    const merged = mergeMaps([
      shard({ recordedAt: '2026-02-02T00:00:00.000Z' }),
      shard({ recordedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(merged.recordedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('keeps the commit when shards agree', () => {
    expect(mergeMaps([shard(), shard()]).commit).toBe('abc123');
  });

  it('drops the commit when shards disagree, so selection cannot trust a stale base', () => {
    const merged = mergeMaps([shard({ commit: 'aaa' }), shard({ commit: 'bbb' })]);
    expect(merged.commit).toBeUndefined();
  });

  it('keeps the recorded config when shards agree, however it was written', () => {
    const merged = mergeMaps([
      shard({ config: recorded({ sourceGlobs: ['src/**'] }) }),
      // The same values reached by a different route: `store` is not part of
      // what a map records, so the shards recorded under one configuration and
      // the merged map may say so.
      shard({
        config: recorded({ sourceGlobs: ['src/**'], store: { dir: 'elsewhere' } }),
      }),
    ]);
    expect(merged.config).toEqual(recorded({ sourceGlobs: ['src/**'] }));
  });

  it('drops the recorded config when shards disagree, so a config change falls open', () => {
    const merged = mergeMaps([
      shard({ config: recorded({ sourceGlobs: ['src/**'] }) }),
      shard({ config: recorded({ sourceGlobs: ['lib/**'] }) }),
    ]);
    expect(merged.config).toBeUndefined();
  });

  it('drops the recorded config when any shard has none', () => {
    const merged = mergeMaps([
      shard({ config: recorded({ sourceGlobs: ['src/**'] }) }),
      shard(),
    ]);
    expect(merged.config).toBeUndefined();
  });

  it('ignores unusable shards and throws when nothing is usable', () => {
    const stale = { ...shard(), schemaVersion: MAP_SCHEMA_VERSION - 1 } as CoverageMap;
    expect(
      mergeMaps([stale, shard({ entries: [entry('a.test.ts', [])] })]).entries,
    ).toHaveLength(1);
    expect(() => mergeMaps([stale])).toThrow(/no usable maps/);
    expect(() => mergeMaps([])).toThrow(/no usable maps/);
  });
});
