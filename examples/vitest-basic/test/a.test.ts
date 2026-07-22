import { expect, test } from 'vitest';
import { alpha } from '../src/a.js';

test('alpha doubles', () => {
  expect(alpha(2)).toBe('[covsel] alpha:4');
});
