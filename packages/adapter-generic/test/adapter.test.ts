import { describe, expect, it } from 'vitest';
import { genericAdapter } from '../src/index.js';

describe('generic adapter', () => {
  it('emits a deduplicated file list', () => {
    const out = genericAdapter.formatSelection([
      { file: 'a.test.ts', name: 'one' },
      { file: 'a.test.ts', name: 'two' },
      { file: 'b.test.ts' },
    ]);
    expect(out).toEqual(['a.test.ts', 'b.test.ts']);
  });
});
