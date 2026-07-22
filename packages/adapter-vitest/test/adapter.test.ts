import { describe, expect, it } from 'vitest';
import { vitestAdapter } from '../src/index.js';

describe('vitest adapter', () => {
  it('identifies itself as "vitest"', () => {
    expect(vitestAdapter.name).toBe('vitest');
  });

  it('formats a selection as a deduplicated file list', () => {
    const out = vitestAdapter.formatSelection([
      { file: 'test/a.test.ts', name: 'one' },
      { file: 'test/a.test.ts', name: 'two' },
      { file: 'test/b.test.ts' },
    ]);
    expect(out).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });

  it('returns an empty list for no tests', () => {
    expect(vitestAdapter.formatSelection([])).toEqual([]);
  });
});
