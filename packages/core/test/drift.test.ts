import { describe, expect, it } from 'vitest';

import { compareSuites } from '../src/drift.js';

/**
 * covsel's idea of the suite and the runner's idea of the suite are two
 * hand-maintained lists, and when they disagree nothing says so today. The
 * disagreement is not symmetric, and the asymmetry is what these tests hold:
 * one direction costs a recording, the other silently shrinks the suite.
 */

describe('the two sets agreeing', () => {
  it('is not drift', () => {
    const drift = compareSuites(['a.test.ts', 'b.test.ts'], ['a.test.ts', 'b.test.ts']);
    expect(drift.unselectable).toEqual([]);
    expect(drift.unrecordable).toEqual([]);
  });

  it('does not depend on the order either side reports in', () => {
    // A runner is free to collect in whatever order it likes -- shard order,
    // slowest-first, alphabetical. Reading that as drift would make the guard
    // fire on every run and be switched off within a day.
    const drift = compareSuites(['a.test.ts', 'b.test.ts'], ['b.test.ts', 'a.test.ts']);
    expect(drift.unselectable).toEqual([]);
    expect(drift.unrecordable).toEqual([]);
  });

  it('does not depend on either side reporting a file once', () => {
    // A runner that collects a file under two projects or two shards names it
    // twice. That is one file to both sides, not a disagreement.
    const drift = compareSuites(['a.test.ts'], ['a.test.ts', 'a.test.ts']);
    expect(drift.unselectable).toEqual([]);
    expect(drift.unrecordable).toEqual([]);
  });
});

describe('a file the runner collects and covsel does not discover', () => {
  // This is the direction that cost this repository two silent outages:
  // `benchmarks/` and then `actions/` were in the runner's include list and not
  // in covsel's testGlobs. Both ran on every full run and could never be
  // selected by any change, so the job demonstrating covsel on itself ran none
  // of them and passed.
  it('is reported as one covsel can never select', () => {
    const drift = compareSuites(['a.test.ts'], ['a.test.ts', 'benchmarks/b.test.ts']);
    expect(drift.unselectable).toEqual(['benchmarks/b.test.ts']);
    expect(drift.unrecordable).toEqual([]);
  });

  it('is reported even when every file covsel knows about is fine', () => {
    // The failure mode being guarded: a check that only looks at the files
    // covsel already knows about can never see a file it does not know about,
    // which is precisely the set at issue here.
    const drift = compareSuites([], ['only.test.ts']);
    expect(drift.unselectable).toEqual(['only.test.ts']);
  });
});

describe('a file covsel discovers and the runner does not collect', () => {
  // The third outage: a Playwright browser test matched covsel's testGlobs and
  // sat in the runner's exclude list, so recording drove a browser test in a job
  // with no browser and died. No map was written at all.
  it('is reported as one the recording would ask the runner for', () => {
    const drift = compareSuites(['a.test.ts', 'browser.test.ts'], ['a.test.ts']);
    expect(drift.unrecordable).toEqual(['browser.test.ts']);
    expect(drift.unselectable).toEqual([]);
  });
});

describe('both directions at once', () => {
  it('are reported separately, since the fix for each is a different file', () => {
    // One is fixed by widening testGlobs, the other by adding to testIgnore.
    // Collapsing them into a single "these differ" list makes the reader work
    // out which is which, on a diagnostic they are reading precisely because
    // they do not already know.
    const drift = compareSuites(
      ['covsel.test.ts', 'both.test.ts'],
      ['runner.test.ts', 'both.test.ts'],
    );
    expect(drift.unselectable).toEqual(['runner.test.ts']);
    expect(drift.unrecordable).toEqual(['covsel.test.ts']);
  });
});

describe('the report', () => {
  it('sorts each side, so two runs on one tree read the same', () => {
    const drift = compareSuites(['c.test.ts', 'a.test.ts'], ['z.test.ts', 'b.test.ts']);
    expect(drift.unrecordable).toEqual(['a.test.ts', 'c.test.ts']);
    expect(drift.unselectable).toEqual(['b.test.ts', 'z.test.ts']);
  });
});
