import { describe, expect, it } from 'vitest';
import { MAP_SCHEMA_VERSION, isUsableMap, type CoverageMap } from '../src/schema.js';

const validMap: CoverageMap = {
  schemaVersion: MAP_SCHEMA_VERSION,
  granularity: 'file',
  recordedAt: '2026-01-01T00:00:00.000Z',
  sentinelHashes: {},
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
    expect(isUsableMap({ schemaVersion: MAP_SCHEMA_VERSION, entries: [] })).toBe(true);
  });

  it('accepts a fully-populated map', () => {
    expect(isUsableMap(validMap)).toBe(true);
  });

  it('rejects a stale schema version (fail open)', () => {
    expect(isUsableMap({ schemaVersion: 0, entries: [] })).toBe(false);
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
    expect(isUsableMap({ schemaVersion: MAP_SCHEMA_VERSION })).toBe(false);
    expect(isUsableMap({ schemaVersion: MAP_SCHEMA_VERSION, entries: 'nope' })).toBe(
      false,
    );
    expect(isUsableMap({ schemaVersion: MAP_SCHEMA_VERSION, entries: null })).toBe(false);
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
