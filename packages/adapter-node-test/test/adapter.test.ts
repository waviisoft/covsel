import { describe, expect, it } from 'vitest';
import { nodeTestAdapter } from '../src/index.js';

describe('node-test adapter', () => {
  it('identifies itself as "node-test"', () => {
    expect(nodeTestAdapter.name).toBe('node-test');
  });

  it('formats a selection as a deduplicated file list', () => {
    const out = nodeTestAdapter.formatSelection([
      { file: 'test/a.test.mjs', name: 'one' },
      { file: 'test/a.test.mjs', name: 'two' },
      { file: 'test/b.test.mjs' },
    ]);
    expect(out).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  });
});
