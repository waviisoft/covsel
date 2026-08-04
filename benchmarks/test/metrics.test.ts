import { describe, expect, it } from 'vitest';

import {
  breakEvenRuns,
  changedOutcomes,
  median,
  type Outcome,
  outcomeMisses,
  percentile,
  selectionRatio,
  splitSelection,
  stratumOf,
  wallClockRatio,
} from '../src/metrics.js';

const outcomes = (entries: Record<string, Outcome>): Map<string, Outcome> =>
  new Map(Object.entries(entries));

describe('changedOutcomes', () => {
  it('finds a test the change broke', () => {
    const base = outcomes({ 'test/a.js': 'passed', 'test/b.js': 'passed' });
    const head = outcomes({ 'test/a.js': 'failed', 'test/b.js': 'passed' });
    expect(changedOutcomes(base, head)).toEqual(['test/a.js']);
  });

  it('finds a test the change fixed', () => {
    const base = outcomes({ 'test/a.js': 'failed' });
    const head = outcomes({ 'test/a.js': 'passed' });
    expect(changedOutcomes(base, head)).toEqual(['test/a.js']);
  });

  it('counts a test the change added, which has no base outcome', () => {
    const base = outcomes({ 'test/a.js': 'passed' });
    const head = outcomes({ 'test/a.js': 'passed', 'test/new.js': 'passed' });
    expect(changedOutcomes(base, head)).toEqual(['test/new.js']);
  });

  it('ignores a test the change deleted, which cannot run at the head', () => {
    const base = outcomes({ 'test/a.js': 'passed', 'test/gone.js': 'passed' });
    const head = outcomes({ 'test/a.js': 'passed' });
    expect(changedOutcomes(base, head)).toEqual([]);
  });

  it('is empty when the change altered nothing', () => {
    const both = outcomes({ 'test/a.js': 'passed', 'test/b.js': 'failed' });
    expect(changedOutcomes(both, both)).toEqual([]);
  });
});

describe('outcomeMisses', () => {
  it('reports a broken test that selection left out', () => {
    const base = outcomes({ 'test/a.js': 'passed', 'test/b.js': 'passed' });
    const head = outcomes({ 'test/a.js': 'failed', 'test/b.js': 'passed' });
    expect(outcomeMisses(base, head, ['test/b.js'])).toEqual(['test/a.js']);
  });

  it('is empty when selection included every test the change altered', () => {
    const base = outcomes({ 'test/a.js': 'passed', 'test/b.js': 'passed' });
    const head = outcomes({ 'test/a.js': 'failed', 'test/b.js': 'passed' });
    expect(outcomeMisses(base, head, ['test/a.js'])).toEqual([]);
  });

  it('is empty for a green change that altered nothing', () => {
    const both = outcomes({ 'test/a.js': 'passed', 'test/b.js': 'passed' });
    expect(outcomeMisses(both, both, [])).toEqual([]);
  });

  it('never misses when a full run selected every discovered file', () => {
    const base = outcomes({ 'test/a.js': 'passed', 'test/b.js': 'passed' });
    const head = outcomes({ 'test/a.js': 'failed', 'test/b.js': 'failed' });
    expect(outcomeMisses(base, head, ['test/a.js', 'test/b.js'])).toEqual([]);
  });
});

describe('splitSelection', () => {
  it('credits a changed test file to policy, not coverage', () => {
    const split = splitSelection({
      selected: ['test/a.js', 'test/changed.js'],
      changedTestFiles: ['test/changed.js'],
      alwaysRun: [],
      creditingNoSource: [],
    });
    expect(split).toEqual({ coverage: ['test/a.js'], policy: ['test/changed.js'] });
  });

  it('credits an entry crediting no source to policy', () => {
    const split = splitSelection({
      selected: ['test/a.js', 'test/support/env.js'],
      changedTestFiles: [],
      alwaysRun: [],
      creditingNoSource: ['test/support/env.js'],
    });
    expect(split.policy).toEqual(['test/support/env.js']);
    expect(split.coverage).toEqual(['test/a.js']);
  });

  it('credits an alwaysRun match to policy', () => {
    const split = splitSelection({
      selected: ['test/fixture.js'],
      changedTestFiles: [],
      alwaysRun: ['test/fixture.js'],
      creditingNoSource: [],
    });
    expect(split).toEqual({ coverage: [], policy: ['test/fixture.js'] });
  });

  it('counts a file only once when several rules claim it', () => {
    const split = splitSelection({
      selected: ['test/a.js'],
      changedTestFiles: ['test/a.js'],
      alwaysRun: ['test/a.js'],
      creditingNoSource: ['test/a.js'],
    });
    expect(split).toEqual({ coverage: [], policy: ['test/a.js'] });
  });

  it('ignores rules naming files selection did not choose', () => {
    const split = splitSelection({
      selected: ['test/a.js'],
      changedTestFiles: ['test/not-selected.js'],
      alwaysRun: [],
      creditingNoSource: [],
    });
    expect(split).toEqual({ coverage: ['test/a.js'], policy: [] });
  });
});

describe('selectionRatio', () => {
  it('is the share of the suite selection chose', () => {
    expect(selectionRatio(13, 91)).toBeCloseTo(13 / 91, 10);
    expect(selectionRatio(1, 4)).toBe(0.25);
  });

  it('treats a suite with no discovered tests as fully selected', () => {
    expect(selectionRatio(0, 0)).toBe(1);
  });
});

describe('wallClockRatio', () => {
  it('counts deciding as well as running', () => {
    const ratio = wallClockRatio({
      recordMs: 174_000,
      affectedMs: 1_000,
      selectedMs: 11_000,
      fullMs: 45_000,
    });
    expect(ratio).toBeCloseTo(12 / 45, 5);
  });

  it('is 1 when there is no full run to compare against', () => {
    expect(wallClockRatio({ recordMs: 0, affectedMs: 0, selectedMs: 0, fullMs: 0 })).toBe(
      1,
    );
  });

  it('exceeds 1 when selecting cost more than running everything', () => {
    const ratio = wallClockRatio({
      recordMs: 0,
      affectedMs: 2_000,
      selectedMs: 5_000,
      fullMs: 4_000,
    });
    expect(ratio).toBeGreaterThan(1);
  });
});

describe('breakEvenRuns', () => {
  it('rounds up to whole runs', () => {
    const runs = breakEvenRuns({
      recordMs: 174_000,
      affectedMs: 1_000,
      selectedMs: 11_000,
      fullMs: 45_000,
    });
    expect(runs).toBe(6);
  });

  it('is undefined when a selected run never pays the recording back', () => {
    expect(
      breakEvenRuns({
        recordMs: 50_000,
        affectedMs: 1_000,
        selectedMs: 4_000,
        fullMs: 4_000,
      }),
    ).toBeUndefined();
  });

  it('is undefined rather than infinite when selection saves nothing', () => {
    expect(
      breakEvenRuns({
        recordMs: 1_000,
        affectedMs: 0,
        selectedMs: 10_000,
        fullMs: 4_000,
      }),
    ).toBeUndefined();
  });
});

describe('stratumOf', () => {
  it.each([
    [1, '1-3'],
    [3, '1-3'],
    [4, '4-10'],
    [10, '4-10'],
    [11, '11+'],
    [400, '11+'],
  ])('puts a %i-file change in %s', (files, expected) => {
    expect(stratumOf(files)).toBe(expected);
  });
});

describe('median and percentile', () => {
  it('takes the middle of an odd-length input', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middles of an even-length input', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('has no median for no observations', () => {
    expect(median([])).toBeUndefined();
    expect(percentile([], 0.9)).toBeUndefined();
  });

  it('reports an observed value rather than an interpolation', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it('clamps a percentile at or beyond the top to the largest observation', () => {
    expect(percentile([1, 2, 3], 1)).toBe(3);
    expect(percentile([1, 2, 3], 2)).toBe(3);
  });
});
