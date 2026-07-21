import { describe, expect, it } from 'vitest';
import { genericAdapter } from '../src/index.js';

describe('generic adapter', () => {
  it('identifies itself as "generic"', () => {
    expect(genericAdapter.name).toBe('generic');
  });

  it('emits a deduplicated file list', () => {
    const out = genericAdapter.formatSelection([
      { file: 'a.test.ts', name: 'one' },
      { file: 'a.test.ts', name: 'two' },
      { file: 'b.test.ts' },
    ]);
    expect(out).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('returns an empty list for no tests', () => {
    expect(genericAdapter.formatSelection([])).toEqual([]);
  });

  it('preserves first-seen file order', () => {
    const out = genericAdapter.formatSelection([
      { file: 'z.test.ts' },
      { file: 'a.test.ts' },
      { file: 'z.test.ts', name: 'again' },
      { file: 'm.test.ts' },
    ]);
    expect(out).toEqual(['z.test.ts', 'a.test.ts', 'm.test.ts']);
  });

  it('collapses file-only and per-test ids of the same file to one entry', () => {
    const out = genericAdapter.formatSelection([
      { file: 'a.test.ts' },
      { file: 'a.test.ts', name: 'scenario 1' },
    ]);
    expect(out).toEqual(['a.test.ts']);
  });
});
