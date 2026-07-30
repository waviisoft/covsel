import assert from 'node:assert/strict';
import { beta } from '../src/b.mjs';

describe('beta', () => {
  it('increments', () => {
    assert.equal(beta(2), '[covsel] beta:3');
  });
});
