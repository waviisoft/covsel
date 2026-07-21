import { describe, expect, it } from 'vitest';
import { MAP_SCHEMA_VERSION, isUsableMap } from '../src/schema.js';

describe('map schema', () => {
  it('accepts a current-version map', () => {
    expect(isUsableMap({ schemaVersion: MAP_SCHEMA_VERSION, entries: [] })).toBe(true);
  });

  it('rejects a stale schema version (fail open)', () => {
    expect(isUsableMap({ schemaVersion: 0, entries: [] })).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isUsableMap(null)).toBe(false);
    expect(isUsableMap('nope')).toBe(false);
  });
});
