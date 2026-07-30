import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  type CoverageMap,
  explainPath,
  extractBlocks,
  type MapEntry,
  MAP_SCHEMA_VERSION,
  MODULE_BLOCK,
  resolveConfig,
} from '../src/index.js';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway project: files on disk, and optionally a map in its store. */
function project(
  files: Record<string, string>,
  map?: Partial<CoverageMap> & Pick<CoverageMap, 'entries'>,
): string {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-explain-'));
  dirs.push(cwd);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), content);
  }
  if (map) {
    mkdirSync(join(cwd, '.covsel'), { recursive: true });
    writeFileSync(
      join(cwd, '.covsel', 'map.json'),
      JSON.stringify({
        schemaVersion: MAP_SCHEMA_VERSION,
        granularity: 'file',
        recordedAt: '2026-07-01T00:00:00.000Z',
        sentinelHashes: {},
        observed: ['**'],
        ...map,
      }),
    );
  }
  return cwd;
}

const config = resolveConfig();

/** The source used by every block-granularity case, and its recorded blocks. */
const MATH = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'export function subtract(a, b) {',
  '  return a - b;',
  '}',
  '',
].join('\n');

function blockHash(name: string): string {
  const found = extractBlocks(MATH, 'src/math.js').find((b) => b.name === name);
  if (!found) throw new Error(`no block named ${name}`);
  return found.hash;
}

const covered: MapEntry = {
  test: { file: 'test/add.test.js' },
  files: [{ file: 'src/math.js', fileHash: 'sha256:math' }],
};

describe('explain: a source file', () => {
  it('lists every test whose entry credits it, with per-test names', async () => {
    const cwd = project(
      { 'src/math.js': MATH, 'test/add.test.js': '', 'test/sub.test.js': '' },
      {
        entries: [
          covered,
          {
            test: { file: 'test/sub.test.js', name: 'subtracts' },
            files: [{ file: 'src/math.js', fileHash: 'sha256:math' }],
          },
          {
            test: { file: 'test/other.test.js' },
            files: [{ file: 'src/other.js', fileHash: 'sha256:other' }],
          },
        ],
      },
    );

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    expect(r.ok).toBe(true);
    expect(r.source?.coveredBy).toEqual([
      { file: 'test/add.test.js' },
      { file: 'test/sub.test.js', name: 'subtracts' },
    ]);
  });

  it('accepts an absolute path and one relative to the repo root alike', async () => {
    const cwd = project({ 'src/math.js': MATH }, { entries: [covered] });

    const relative = await explainPath({ cwd, config, path: 'src/math.js' });
    const absolute = await explainPath({ cwd, config, path: join(cwd, 'src/math.js') });

    expect(relative.file).toBe('src/math.js');
    expect(absolute).toEqual(relative);
  });

  it('names the covered blocks and reports an uncovered function as covered by nothing', async () => {
    const cwd = project(
      { 'src/math.js': MATH, 'test/add.test.js': '' },
      {
        granularity: 'block',
        entries: [
          {
            ...covered,
            blocks: [
              { file: 'src/math.js', blockHash: blockHash(MODULE_BLOCK) },
              { file: 'src/math.js', blockHash: blockHash('add') },
            ],
          },
        ],
      },
    );

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    const byName = Object.fromEntries(
      (r.source?.blocks ?? []).map((b) => [b.name, b.coveredBy]),
    );
    expect(byName['add']).toEqual([{ file: 'test/add.test.js' }]);
    expect(byName['subtract']).toEqual([]);
    expect(r.source?.changedBlocks).toBe(0);
  });

  it('counts recorded blocks the file no longer contains as drift', async () => {
    const cwd = project(
      { 'src/math.js': MATH, 'test/add.test.js': '' },
      {
        granularity: 'block',
        entries: [
          {
            ...covered,
            blocks: [
              { file: 'src/math.js', blockHash: blockHash('add') },
              { file: 'src/math.js', blockHash: 'sha256:recorded-then-edited' },
            ],
          },
        ],
      },
    );

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    expect(r.source?.changedBlocks).toBe(1);
  });

  it('withholds block detail when the crediting tests recorded whole files only', async () => {
    const cwd = project(
      { 'src/math.js': MATH, 'test/add.test.js': '' },
      { granularity: 'block', entries: [covered] },
    );

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    expect(r.source?.blocks).toBeUndefined();
    expect(r.source?.blocksUnavailable).toBeTruthy();
    expect(r.source?.fileOnly).toEqual([{ file: 'test/add.test.js' }]);
  });

  it('reports a file no entry credits as covered by nothing', async () => {
    const cwd = project(
      { 'src/lonely.js': 'export const x = 1;\n', 'src/math.js': MATH },
      { entries: [covered] },
    );

    const r = await explainPath({ cwd, config, path: 'src/lonely.js' });

    expect(r.ok).toBe(true);
    expect(r.observed).toBe(true);
    expect(r.source?.coveredBy).toEqual([]);
  });

  it('does not read a path outside the observed scope as covered by nothing', async () => {
    const cwd = project(
      { 'src/lonely.js': 'export const x = 1;\n', 'src/math.js': MATH },
      { observed: ['src/math.js'], entries: [covered] },
    );

    const r = await explainPath({ cwd, config, path: 'src/lonely.js' });

    expect(r.ok).toBe(true);
    expect(r.observed).toBe(false);
  });

  it('says a sentinel forces a full run whatever covers it', async () => {
    const cwd = project({ 'package.json': '{}\n' }, { entries: [covered] });

    const r = await explainPath({ cwd, config, path: 'package.json' });

    expect(r.sentinel).toBe(true);
  });

  it('explains a file the map credits that is no longer in the tree', async () => {
    const cwd = project({ 'test/add.test.js': '' }, { entries: [covered] });

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    expect(r.ok).toBe(true);
    expect(r.present).toBe(false);
    expect(r.source?.coveredBy).toEqual([{ file: 'test/add.test.js' }]);
  });
});

describe('explain: a test file', () => {
  it('lists each recorded unit with the sources it covered', async () => {
    const cwd = project(
      { 'test/add.test.js': '', 'src/math.js': MATH },
      {
        entries: [
          {
            test: { file: 'test/add.test.js', name: 'adds' },
            files: [
              { file: 'src/math.js', fileHash: 'sha256:math' },
              { file: 'src/util.js', fileHash: 'sha256:util' },
            ],
          },
          {
            test: { file: 'test/add.test.js', name: 'adds negatives' },
            files: [{ file: 'src/math.js', fileHash: 'sha256:math' }],
          },
        ],
      },
    );

    const r = await explainPath({ cwd, config, path: 'test/add.test.js' });

    expect(r.isTestPath).toBe(true);
    expect(r.test?.unrecorded).toBe(false);
    expect(r.test?.units).toEqual([
      {
        test: { file: 'test/add.test.js', name: 'adds' },
        sources: ['src/math.js', 'src/util.js'],
      },
      {
        test: { file: 'test/add.test.js', name: 'adds negatives' },
        sources: ['src/math.js'],
      },
    ]);
  });

  it('reports a test the map does not mention as one that always runs', async () => {
    const cwd = project(
      { 'test/fresh.test.js': '', 'test/add.test.js': '' },
      { entries: [covered] },
    );

    const r = await explainPath({ cwd, config, path: 'test/fresh.test.js' });

    expect(r.ok).toBe(true);
    expect(r.test?.unrecorded).toBe(true);
    // Nothing credits it, and it is a test — there is no source view to give,
    // and an empty one would read as "this test covers nothing".
    expect(r.source).toBeUndefined();
  });

  it('explains a test file that other tests also cover as both at once', async () => {
    const cwd = project(
      { 'test/helper.test.js': '', 'test/add.test.js': '' },
      {
        entries: [
          {
            test: { file: 'test/helper.test.js' },
            files: [{ file: 'src/math.js', fileHash: 'sha256:math' }],
          },
          {
            test: { file: 'test/add.test.js' },
            files: [{ file: 'test/helper.test.js', fileHash: 'sha256:helper' }],
          },
        ],
      },
    );

    const r = await explainPath({ cwd, config, path: 'test/helper.test.js' });

    expect(r.test?.units).toHaveLength(1);
    expect(r.source?.coveredBy).toEqual([{ file: 'test/add.test.js' }]);
  });
});

describe('explain: nothing to explain', () => {
  it('says the next selection is a full run when no map is recorded', async () => {
    const cwd = project({ 'src/math.js': MATH });

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    expect(r.ok).toBe(true);
    expect(r.mapExists).toBe(false);
    expect(r.noMapReason).toBeTruthy();
  });

  it('refuses a path outside the repository, naming it', async () => {
    const cwd = project({ 'src/math.js': MATH }, { entries: [covered] });

    const r = await explainPath({ cwd, config, path: '../elsewhere.js' });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('../elsewhere.js');
  });

  it('refuses a path the repository does not contain and the map never saw', async () => {
    const cwd = project({ 'src/math.js': MATH }, { entries: [covered] });

    const r = await explainPath({ cwd, config, path: 'src/typo.js' });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('src/typo.js');
  });

  it('refuses a directory rather than explaining the tree under it', async () => {
    const cwd = project({ 'src/math.js': MATH }, { entries: [covered] });

    const r = await explainPath({ cwd, config, path: 'src' });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('directory');
  });
});
