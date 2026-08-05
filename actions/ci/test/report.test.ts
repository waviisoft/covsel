import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JavaScript, because the action runs from a checkout
// with no build step and nothing may compile it.
import { headline, outputs, readFacts, summary } from '../report.mjs';

/**
 * The reporter is where a selection becomes a claim someone acts on, so what is
 * checked here is the claims: that a full run says so and never reads as a
 * narrow one, that a count nobody measured prints as unknown rather than as
 * zero, and that the outputs a caller branches on cannot be misread.
 *
 * The selection itself is covsel's to be right about. Everything below is the
 * rendering of an answer already given.
 */

const status = {
  mapPath: '/repo/.covsel/map.json',
  mapState: 'usable',
  commit: '9c81de4a2f60b7c3d5e1f0a2b4c6d8e0f2a4b6c8',
  recordedAt: '2026-08-05T00:00:00.000Z',
  ageMs: 12 * 60000,
  granularity: 'block',
  entryCount: 37,
  discoveredTestCount: 37,
  changedSentinels: [],
  nextIsFullRun: false,
};

const narrowed = {
  fullRun: false,
  files: ['test/math.test.js'],
  tests: ['test/math.test.js'],
  selected: [{ file: 'test/math.test.js' }],
  discovered: 37,
};

describe('a selection that narrowed', () => {
  it('reports the count against the denominator that makes it mean something', () => {
    const facts = readFacts({ mode: 'select', affected: narrowed, status });
    expect(headline(facts)).toBe('Selected 1 of 37 test file(s); only those ran.');
  });

  it('says what would have run under a dry run, not what did', () => {
    const facts = readFacts({ mode: 'select', dryRun: true, affected: narrowed, status });
    expect(headline(facts)).toContain('would run');
    expect(summary(facts)).toContain('ran nothing');
  });

  it('carries the map commit and age, since a restored map is only as good as those', () => {
    const facts = readFacts({ mode: 'select', affected: narrowed, status });
    const rendered = summary(facts);
    expect(rendered).toContain('9c81de4a2f60');
    expect(rendered).toContain('12m ago');
  });
});

describe('a full run', () => {
  // The failure this guards: a full run rendered as a small number, or as an
  // empty selection, reads like covsel saved the job time when it did the
  // opposite. Nobody investigates a green job that claims success.
  const full = {
    fullRun: true,
    reason: 'sentinel changed since the map was recorded: package.json',
    files: ['a.test.js', 'b.test.js'],
    tests: ['a.test.js', 'b.test.js'],
    selected: [{ file: 'a.test.js' }, { file: 'b.test.js' }],
    discovered: 2,
  };

  it('says so, and says why', () => {
    const facts = readFacts({ mode: 'select', affected: full, status });
    expect(headline(facts)).toBe(
      'Full run: All 2 test file(s) run -- sentinel changed since the map was recorded: package.json.',
    );
  });

  it('never reports it as a selection of some tests', () => {
    const facts = readFacts({ mode: 'select', affected: full, status });
    expect(summary(facts)).toContain('| Selected | everything |');
    expect(headline(facts)).not.toContain('only those');
  });

  it('sets full-run true so a caller branches on the verdict, not on a list length', () => {
    const facts = readFacts({ mode: 'select', affected: full, status });
    const written = outputs(facts);
    expect(written).toContain('full-run=true');
    // The list is still every discovered file. A caller that filtered by it
    // would at worst run everything, which is the safe direction; one reading an
    // empty list would run nothing.
    expect(written).toContain('affected=["a.test.js","b.test.js"]');
  });
});

describe('what nobody measured', () => {
  it('prints as unknown rather than as zero', () => {
    // record mode makes no selection, so there is no selected count. Rendering
    // that as 0 would describe a narrowing that was never attempted.
    const facts = readFacts({ mode: 'record', status });
    expect(facts.selectedCount).toBeUndefined();
    expect(outputs(facts)).toContain('selected-count=');
    expect(outputs(facts)).not.toContain('selected-count=0');
  });

  it('does not describe a map covsel could not read', () => {
    const facts = readFacts({
      mode: 'select',
      status: {
        mapPath: '/repo/.covsel/map.json',
        mapState: 'unusable',
        unusableReason: 'schema v3, covsel reads v4',
        changedSentinels: [],
        nextIsFullRun: true,
      },
    });
    const rendered = summary(facts);
    expect(rendered).toContain('unusable');
    expect(rendered).toContain('schema v3');
    expect(rendered).not.toContain('Recorded at');
  });

  it('treats a missing status as an absent map rather than crashing', () => {
    const facts = readFacts({ mode: 'select' });
    expect(facts.mapState).toBe('absent');
    expect(() => summary(facts)).not.toThrow();
  });
});

describe('a fetch that found nothing', () => {
  it('says the suite runs in full, and that this is the safe outcome', () => {
    const facts = readFacts({
      mode: 'select',
      status,
      fetch: { ok: false, reason: 'no archive at .covsel/archive', skipped: [] },
    });
    expect(summary(facts)).toContain('runs in full');
    expect(summary(facts)).toContain('safe');
  });

  it('names every candidate it passed over, with the reason', () => {
    // This is the line that turns "covsel saves us nothing" into "our checkout
    // is too shallow", so it has to survive into the summary.
    const facts = readFacts({
      mode: 'select',
      status,
      fetch: {
        ok: false,
        reason: 'no usable archived map',
        skipped: [{ commit: '3f2a1c9e8b7d0000', reason: 'not in this checkout' }],
      },
    });
    expect(summary(facts)).toContain('3f2a1c9e8b7d');
    expect(summary(facts)).toContain('not in this checkout');
  });
});

describe('the outputs', () => {
  it('are one line each, whatever the reason says', () => {
    const facts = readFacts({
      mode: 'select',
      affected: { ...narrowed, fullRun: true, reason: 'first line\nsecond line' },
      status,
    });
    const written = outputs(facts);
    // A newline here would end the output early and leave the rest of the
    // sentence being parsed as another key.
    expect(written.split('\n')).toHaveLength(8);
    expect(written).toContain('full-run-reason=first line second line');
  });

  it('give the selection as JSON, so a matrix can consume it', () => {
    const facts = readFacts({ mode: 'select', affected: narrowed, status });
    const line = outputs(facts)
      .split('\n')
      .find((l) => l.startsWith('affected='));
    expect(JSON.parse(line!.slice('affected='.length))).toEqual(['test/math.test.js']);
  });
});
