import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beta } from '../src/b.mjs';

test('beta increments', () => {
  assert.equal(beta(2), '[covsel] beta:3');
});
