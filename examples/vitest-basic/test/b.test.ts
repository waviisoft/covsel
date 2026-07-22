import { expect, test } from 'vitest';
import { beta } from '../src/b.js';

test('beta increments', () => {
  expect(beta(2)).toBe('[covsel] beta:3');
});
