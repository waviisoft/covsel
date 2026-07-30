import { describe, expect, it } from 'vitest';

import { makeMatcher, OBSERVES_EVERYTHING, resolveConfigFor } from '@covsel/core';

import { MOCHA_TEST_GLOBS, mochaAdapter } from '../src/index.js';

describe('mocha adapter', () => {
  it('identifies itself as "mocha"', () => {
    expect(mochaAdapter.name).toBe('mocha');
  });

  it('formats a selection as a deduplicated file list', () => {
    const out = mochaAdapter.formatSelection([
      { file: 'test/a.test.mjs', name: 'alpha doubles' },
      { file: 'test/a.test.mjs', name: 'alpha tags' },
      { file: 'test/b.test.mjs' },
    ]);
    expect(out).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  });

  it('narrows a run itself rather than handing over a file list', () => {
    expect(typeof mochaAdapter.runSelection).toBe('function');
  });

  it('discovers the specs Mocha itself would run', () => {
    // Mocha's own default is the `test` directory with the `js`, `cjs`, and
    // `mjs` extensions, which covsel's `*.test.*` default does not match. The
    // adapter's default has to be a superset of what Mocha would run: a spec
    // covsel never discovers is never selected, so it would sit out every
    // narrowed run while looking perfectly healthy.
    const isTest = makeMatcher([...MOCHA_TEST_GLOBS]);
    for (const rel of [
      'test/cart.js',
      'test/cart.cjs',
      'test/cart.mjs',
      'test/unit/nested/cart.js',
      'src/cart.spec.js',
      'src/cart.test.mjs',
    ]) {
      expect(isTest(rel), rel).toBe(true);
    }
    for (const rel of ['src/cart.js', 'lib/testing.js', 'README.md']) {
      expect(isTest(rel), rel).toBe(false);
    }
  });

  it('declares those globs to covsel', () => {
    expect(mochaAdapter.defaultTestGlobs).toEqual(MOCHA_TEST_GLOBS);
  });

  it('declares that it observes the whole repository', () => {
    // The shim drives the inspector inside the Mocha process, which reports
    // every script that process loads, so nothing a run executes is outside
    // what this recorder would have seen.
    const recorder = mochaAdapter.createRecorder({
      command: ['mocha'],
      cwd: process.cwd(),
      config: resolveConfigFor(mochaAdapter),
    });
    expect(recorder.observes).toEqual(OBSERVES_EVERYTHING);
  });
});
