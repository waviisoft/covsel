import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type IstanbulReport,
  istanbulCoverage,
  readIstanbulReport,
  resolveConfig,
} from '../src/index.js';

/**
 * The istanbul reader used to live twice, once in each of the two adapters whose
 * runners transform sources before executing them. It decides which sources a
 * test is credited with, so a fix applied to one copy and not the other would
 * leave one runner quietly under-recording — the fail-closed direction. These
 * tests hold the shared reader to what the copies did. That neither adapter kept
 * a copy is checked in `@covsel/conformance`'s suite, which is the right place to
 * read a sibling package's source from.
 */

const config = resolveConfig();

let cwd: string;

/** One source with two functions, so blocks are distinguishable. */
const SOURCE = [
  'export function alpha(x) {',
  '  return x + 1;',
  '}',
  '',
  'export function beta(x) {',
  '  return x - 1;',
  '}',
  '',
].join('\n');

/** An istanbul entry for `SOURCE` where only `alpha` ran. */
function entryForSource(abs: string): IstanbulReport[string] {
  return {
    path: abs,
    s: { 0: 1, 1: 0 },
    f: { 0: 1, 1: 0 },
    fnMap: {
      0: { loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } } },
      1: { loc: { start: { line: 5, column: 0 }, end: { line: 7, column: 1 } } },
    },
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-istanbul-'));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.js'), SOURCE);
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('reading a report from disk', () => {
  it('parses one that is there', () => {
    const file = join(cwd, 'coverage-final.json');
    writeFileSync(file, JSON.stringify({ 'src/a.js': { s: { 0: 1 } } }));
    expect(readIstanbulReport(file)).toEqual({ 'src/a.js': { s: { 0: 1 } } });
  });

  it('returns undefined for a missing, unparseable, or non-object file', () => {
    expect(readIstanbulReport(join(cwd, 'nope.json'))).toBeUndefined();
    const file = join(cwd, 'bad.json');
    writeFileSync(file, 'not json');
    expect(readIstanbulReport(file)).toBeUndefined();
    writeFileSync(file, '[1, 2, 3]');
    expect(readIstanbulReport(file)).toBeUndefined();
  });
});

describe('a malformed report entry is skipped, not fatal', () => {
  it('contributes nothing while well-formed entries are still recorded', () => {
    const abs = join(cwd, 'src', 'a.js');
    const result = istanbulCoverage(
      {
        'no-path-no-counters': {},
        'not-even-an-object': null as unknown as IstanbulReport[string],
        [abs]: entryForSource(abs),
      },
      { cwd, config },
    );
    expect(result.files.map((f) => f.file)).toEqual(['src/a.js']);
  });

  it('credits an entry whose counters are all zero, because the file still loaded', () => {
    // covsel/covsel#82. A module of nothing but declarations executes no
    // statement when it loads, so every counter is zero -- and dropping it
    // recorded no relationship at all between the test and a file it imported.
    // That is the fail-closed direction: give the module a top-level side
    // effect, or make it throw on import, and every importer's behaviour changes
    // while none of them are selected.
    const abs = join(cwd, 'src', 'a.js');
    const result = istanbulCoverage(
      { [abs]: { path: abs, s: { 0: 0 }, f: { 0: 0 } } },
      { cwd, config },
    );
    expect(result.files.map((f) => f.file)).toEqual(['src/a.js']);
  });

  it('counts a branch hit as execution', () => {
    const abs = join(cwd, 'src', 'a.js');
    const result = istanbulCoverage(
      { [abs]: { path: abs, b: { 0: [0, 2] } } },
      { cwd, config },
    );
    expect(result.files.map((f) => f.file)).toEqual(['src/a.js']);
  });
});

describe('what the reader credits', () => {
  it('keys off the entry path, falling back to the report key', () => {
    const abs = join(cwd, 'src', 'a.js');
    const keyed = istanbulCoverage({ [abs]: { s: { 0: 1 } } }, { cwd, config });
    expect(keyed.files.map((f) => f.file)).toEqual(['src/a.js']);
  });

  it('drops files outside the repository', () => {
    const outside = join(tmpdir(), 'elsewhere', 'b.js');
    const result = istanbulCoverage(
      { [outside]: { path: outside, s: { 0: 1 } } },
      { cwd, config },
    );
    expect(result.files).toEqual([]);
  });

  it('drops files the project does not count as sources', () => {
    const abs = join(cwd, 'src', 'a.js');
    const narrow = resolveConfig({ sourceGlobs: ['lib/**'] });
    const result = istanbulCoverage(
      { [abs]: entryForSource(abs) },
      { cwd, config: narrow },
    );
    expect(result.files).toEqual([]);
  });

  it('hashes each covered file, so selection can tell it changed', () => {
    const abs = join(cwd, 'src', 'a.js');
    const result = istanbulCoverage({ [abs]: entryForSource(abs) }, { cwd, config });
    expect(result.files[0]?.fileHash).toMatch(/^sha256:/);
  });
});

describe('block extraction follows the configured granularity', () => {
  it('returns blocks for the functions that ran, and not the ones that did not', () => {
    const abs = join(cwd, 'src', 'a.js');
    const result = istanbulCoverage({ [abs]: entryForSource(abs) }, { cwd, config });
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.every((b) => b.file === 'src/a.js')).toBe(true);
    // `beta` never ran, so its block must not be credited.
    const all = istanbulCoverage(
      {
        [abs]: {
          ...entryForSource(abs),
          f: { 0: 1, 1: 1 },
        },
      },
      { cwd, config },
    );
    expect(all.blocks.length).toBeGreaterThan(result.blocks.length);
  });

  it('returns covered files and no blocks at file granularity', () => {
    const abs = join(cwd, 'src', 'a.js');
    const fileLevel = resolveConfig({ granularity: 'file' });
    const result = istanbulCoverage(
      { [abs]: entryForSource(abs) },
      { cwd, config: fileLevel },
    );
    expect(result.files.map((f) => f.file)).toEqual(['src/a.js']);
    expect(result.blocks).toEqual([]);
  });

  it('fails the recording for a covered source that is no longer on disk', () => {
    // A file the report says ran but which cannot be read cannot be hashed, and
    // an entry crediting it without a hash would be a coverage claim selection
    // could never check. Throwing fails this test file's recording, which is the
    // safe direction; crediting it silently is not.
    const abs = join(cwd, 'src', 'gone.js');
    writeFileSync(abs, SOURCE);
    const entry = entryForSource(abs);
    rmSync(abs);
    expect(() => istanbulCoverage({ [abs]: entry }, { cwd, config })).toThrow();
  });
});
