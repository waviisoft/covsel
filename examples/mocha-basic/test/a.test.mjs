import assert from 'node:assert/strict';
import { alpha } from '../src/a.mjs';

describe('alpha', () => {
  it('doubles', () => {
    assert.equal(alpha(2), '[covsel] alpha:4');
  });
});
