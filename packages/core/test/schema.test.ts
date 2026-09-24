import { describe, expect, it } from 'vitest';
import {
  GRANULARITIES,
  MAP_SCHEMA_VERSION,
  isUsableMap,
  type CoverageMap,
} from '../src/schema.js';

const validMap: CoverageMap = {
  schemaVersion: MAP_SCHEMA_VERSION,
  granularity: 'file',
  recordedAt: '2026-01-01T00:00:00.000Z',
  sentinelHashes: {},
  observed: ['**'],
  entries: [],
};

describe('MAP_SCHEMA_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(MAP_SCHEMA_VERSION)).toBe(true);
    expect(MAP_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

describe('isUsableMap', () => {
  it('accepts a current-version map', () => {
    expect(
      isUsableMap({
        schemaVersion: MAP_SCHEMA_VERSION,
        granularity: 'block',
        observed: [],
        entries: [],
      }),
    ).toBe(true);
  });

  it('accepts a fully-populated map', () => {
    expect(isUsableMap(validMap)).toBe(true);
  });

  it('rejects a stale schema version (fail open)', () => {
    expect(isUsableMap({ schemaVersion: 0, observed: [], entries: [] })).toBe(false);
    expect(isUsableMap({ ...validMap, schemaVersion: MAP_SCHEMA_VERSION - 1 })).toBe(
      false,
    );
  });

  it('rejects a future schema version (fail open)', () => {
    expect(isUsableMap({ ...validMap, schemaVersion: MAP_SCHEMA_VERSION + 1 })).toBe(
      false,
    );
  });

  it('rejects a map whose entries are missing or not an array', () => {
    expect(isUsableMap({ schemaVersion: MAP_SCHEMA_VERSION, observed: [] })).toBe(false);
    expect(
      isUsableMap({ schemaVersion: MAP_SCHEMA_VERSION, observed: [], entries: 'nope' }),
    ).toBe(false);
    expect(
      isUsableMap({ schemaVersion: MAP_SCHEMA_VERSION, observed: [], entries: null }),
    ).toBe(false);
  });

  it('rejects a map that does not say what it observed (fail open)', () => {
    // A map predating the field, or one hand-edited to drop it, must not be
    // read as "observed everything" — that is the reading that skips tests.
    const withoutObserved: Record<string, unknown> = { ...validMap };
    delete withoutObserved.observed;
    expect(isUsableMap(withoutObserved)).toBe(false);
    expect(isUsableMap({ ...validMap, observed: 'src/**' })).toBe(false);
    expect(isUsableMap({ ...validMap, observed: ['src/**', 7] })).toBe(false);
  });

  it('accepts every granularity covsel implements', () => {
    for (const granularity of GRANULARITIES) {
      expect(isUsableMap({ ...validMap, granularity })).toBe(true);
    }
  });

  it('rejects a granularity covsel does not implement (fail open)', () => {
    // Nothing covsel ships writes one, so this map was hand-edited or written by
    // a covsel that knows something this one does not. Either way its entries
    // mean something unknown, and a reader that guessed would be guessing about
    // what to skip.
    expect(isUsableMap({ ...validMap, granularity: 'line' })).toBe(false);
    expect(isUsableMap({ ...validMap, granularity: 'statement' })).toBe(false);
    expect(isUsableMap({ ...validMap, granularity: 7 })).toBe(false);
  });

  it('rejects a map that does not say what granularity it was recorded at', () => {
    const withoutGranularity: Record<string, unknown> = { ...validMap };
    delete withoutGranularity.granularity;
    expect(isUsableMap(withoutGranularity)).toBe(false);
  });

  it('accepts a map with no test inventory, and one with a well-formed one', () => {
    expect(isUsableMap(validMap)).toBe(true);
    expect(
      isUsableMap({
        ...validMap,
        testInventory: { source: 'sha:aaa', entries: [{ id: { file: 'spec:a.md' } }] },
      }),
    ).toBe(true);
  });

  it('rejects a malformed test inventory rather than let a reader crash on it (fail open)', () => {
    // Every reader that indexes into `testInventory.entries` -- selection,
    // `status`, `explain` -- would throw a TypeError on a shape like this one
    // rather than fall open, which is worse than under-selecting: it can take
    // the whole run down instead of just widening it.
    expect(isUsableMap({ ...validMap, testInventory: { source: 'sha:aaa' } })).toBe(
      false,
    );
    expect(isUsableMap({ ...validMap, testInventory: { entries: [] } })).toBe(false);
    expect(isUsableMap({ ...validMap, testInventory: 'sha:aaa' })).toBe(false);
  });

  it('rejects a malformed entry inside an otherwise well-formed test inventory', () => {
    // The shape check on `testInventory` itself is not enough on its own if
    // what it lets through still throws one level in -- every reader walks
    // straight to `entry.id.file` with no guard of its own.
    const withEntries = (entries: unknown[]) => ({
      ...validMap,
      testInventory: { source: 'sha:aaa', entries },
    });
    expect(isUsableMap(withEntries([null]))).toBe(false);
    expect(isUsableMap(withEntries(['not an object']))).toBe(false);
    expect(isUsableMap(withEntries([{}]))).toBe(false); // no `id` at all
    expect(isUsableMap(withEntries([{ id: null }]))).toBe(false);
    expect(isUsableMap(withEntries([{ id: {} }]))).toBe(false); // no `id.file`
    expect(isUsableMap(withEntries([{ id: { file: 7 } }]))).toBe(false);
  });

  it('rejects non-object garbage', () => {
    expect(isUsableMap(null)).toBe(false);
    expect(isUsableMap(undefined)).toBe(false);
    expect(isUsableMap('nope')).toBe(false);
    expect(isUsableMap(42)).toBe(false);
    expect(isUsableMap([])).toBe(false);
  });

  it('narrows the type for downstream use when it returns true', () => {
    const maybe: unknown = validMap;
    if (isUsableMap(maybe)) {
      // These accesses only compile if the type guard narrowed correctly.
      expect(maybe.entries).toEqual([]);
      expect(maybe.schemaVersion).toBe(MAP_SCHEMA_VERSION);
    } else {
      throw new Error('expected validMap to be usable');
    }
  });
});
