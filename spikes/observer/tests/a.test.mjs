import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alpha } from '../src/a.mjs';

test('alpha doubles', () => {
  assert.equal(alpha(2), '[covsel-spike] alpha:4');
});
