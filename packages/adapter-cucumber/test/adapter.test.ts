import { describe, expect, it } from 'vitest';
import { CUCUMBER_TEST_GLOBS, cucumberAdapter } from '../src/index.js';

describe('cucumber adapter', () => {
  it('identifies itself as "cucumber"', () => {
    expect(cucumberAdapter.name).toBe('cucumber');
  });

  it('formats a selection as a deduplicated feature-file list', () => {
    const out = cucumberAdapter.formatSelection([
      { file: 'features/shop.feature', name: 'totalling a cart' },
      { file: 'features/shop.feature', name: 'greeting a customer' },
      { file: 'features/admin.feature' },
    ]);
    expect(out).toEqual(['features/shop.feature', 'features/admin.feature']);
  });

  it('discovers feature files by default', () => {
    expect(CUCUMBER_TEST_GLOBS).toEqual(['**/*.feature']);
  });
});
