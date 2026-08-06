import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  type CoverageMap,
  createGenericRecorder,
  explainPath,
  extractBlocks,
  gitHeadCommit,
  type MapEntry,
  MAP_SCHEMA_VERSION,
  LOAD_BLOCK,
  MODULE_BLOCK,
  recordedConfig,
  recordMap,
  resolveConfig,
  selectAffected,
} from '../src/index.js';
import { commitAll } from './helpers/repo.js';

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

  it('does not call a block uncovered when a whole-file entry selects on it', async () => {
    // A map is block-granular as soon as any entry has blocks, so one entry with
    // blocks beside one crediting whole files is ordinary. The selector falls
    // back to file level for the entry without blocks, so a change to any block
    // of this file runs that test — "no recorded test executes it" is the
    // opposite of what selection does.
    const cwd = project(
      { 'src/math.js': MATH, 'test/add.test.js': '', 'test/whole.test.js': '' },
      {
        granularity: 'block',
        entries: [
          {
            ...covered,
            blocks: [{ file: 'src/math.js', blockHash: blockHash('add') }],
          },
          {
            test: { file: 'test/whole.test.js' },
            files: [{ file: 'src/math.js', fileHash: 'sha256:math' }],
          },
        ],
      },
    );

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    const verdicts = Object.fromEntries(
      (r.source?.blocks ?? []).map((b) => [b.name, b.verdict]),
    );
    expect(verdicts['add']).toBe('covered');
    expect(verdicts['subtract']).toBe('file-level');
    expect(r.source?.fileOnly).toEqual([{ file: 'test/whole.test.js' }]);
  });

  it('does not call a block uncovered when a recorded block drifted out of the file', async () => {
    // The recorded hash for `add` is gone because its body was edited. That
    // hash lands in the selector's changed set, so a change to this file selects
    // the test that ran it — the current `add` is unmatched, not uncovered.
    const cwd = project(
      { 'src/math.js': MATH, 'test/add.test.js': '' },
      {
        granularity: 'block',
        entries: [
          {
            ...covered,
            blocks: [
              { file: 'src/math.js', blockHash: blockHash(MODULE_BLOCK) },
              { file: 'src/math.js', blockHash: 'sha256:add-before-the-edit' },
            ],
          },
        ],
      },
    );

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    const verdicts = Object.fromEntries(
      (r.source?.blocks ?? []).map((b) => [b.name, b.verdict]),
    );
    expect(verdicts[MODULE_BLOCK]).toBe('covered');
    expect(verdicts['add']).toBe('unmatched');
    expect(verdicts['subtract']).toBe('unmatched');
    expect(r.source?.changedBlocks).toBe(1);
  });

  it('withholds block detail for a recorded file the tree no longer has', async () => {
    const cwd = project(
      { 'test/add.test.js': '' },
      {
        granularity: 'block',
        entries: [
          {
            ...covered,
            blocks: [{ file: 'src/math.js', blockHash: blockHash('add') }],
          },
        ],
      },
    );

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    expect(r.source?.blocks).toBeUndefined();
    expect(r.source?.blocksUnavailable).toContain('working tree');
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

    const blocks = Object.fromEntries((r.source?.blocks ?? []).map((b) => [b.name, b]));
    expect(blocks['add']?.coveredBy).toEqual([{ file: 'test/add.test.js' }]);
    expect(blocks['add']?.verdict).toBe('covered');
    expect(blocks['subtract']?.coveredBy).toEqual([]);
    // Nothing drifted and no entry credits the file whole, so this one is a
    // measurement: no recorded test ran it.
    expect(blocks['subtract']?.verdict).toBe('uncovered');
    // The load block, which the recording did not name because this test called
    // into the file and so got the module block instead. A unit that ran the
    // module block ran the top level, which is the load -- reporting it as
    // `uncovered`, "nothing recorded executes this code", would be saying that
    // about the one block that runs every time the file is imported.
    expect(blocks[LOAD_BLOCK]?.verdict).toBe('covered');
    expect(blocks[LOAD_BLOCK]?.coveredBy).toEqual([{ file: 'test/add.test.js' }]);
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

    expect(r.forcesFullRun).toBeTruthy();
    expect(r.forcesFullRun?.always).toBe(true);
  });

  it('stops calling a lockfile unconditional once the map records an inventory', async () => {
    // A lockfile is a sentinel that no longer always fires: a bump the map can
    // account for selects just the tests that ran the packages that moved. Saying
    // "always" here would be telling a reader something `affected` contradicts on
    // the next bump -- the same drift `status` is kept clear of, one command
    // further out.
    const cwd = project(
      { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' },
      {
        entries: [covered],
        dependencies: {
          manager: 'pnpm',
          marker: 'node_modules/.pnpm/lock.yaml',
          markerHash: 'sha256:x',
          inventory: { 'left-pad': ['.:node_modules/.pnpm/left-pad@1.3.0'] },
        },
      },
    );

    const r = await explainPath({ cwd, config, path: 'pnpm-lock.yaml' });

    expect(r.forcesFullRun?.always).toBe(false);
    expect(r.forcesFullRun?.why).toContain('packages that moved');
  });

  it('keeps calling a lockfile unconditional when the map records no inventory', async () => {
    // Which is every map recorded before that field existed, so this is what
    // almost every reader gets.
    const cwd = project(
      { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' },
      { entries: [covered] },
    );

    const r = await explainPath({ cwd, config, path: 'pnpm-lock.yaml' });

    expect(r.forcesFullRun?.always).toBe(true);
    expect(r.forcesFullRun?.why).toContain('sentinel');
  });

  it("says covsel's own config forces a full run, though it is not a sentinel", async () => {
    // The policy asks about a config change without going through the sentinel
    // list, so reading sentinels alone would report the file that decides what
    // the whole map means as one a change to selects nothing. This map records
    // no configuration, so any change to the file forces the run.
    const cwd = project({ 'covsel.json': '{}\n' }, { entries: [covered] });

    const r = await explainPath({ cwd, config, path: 'covsel.json' });

    expect(r.forcesFullRun?.always).toBe(true);
    expect(r.forcesFullRun?.why).toContain('no values to compare against');
  });

  it('says a config change is judged by its values when the map records them', async () => {
    const cwd = project(
      { 'covsel.json': '{}\n' },
      { entries: [covered], config: recordedConfig(config) },
    );

    const r = await explainPath({ cwd, config, path: 'covsel.json' });

    // Not unconditional: a reworded comment moves no value, and telling a reader
    // it runs the whole suite would be describing behavior covsel no longer has.
    expect(r.forcesFullRun?.always).toBe(false);
    expect(r.forcesFullRun?.why).toContain('moves a value covsel reads');
  });

  it('reports a config file the project listed as a sentinel as always forcing one', async () => {
    // The listing is a deliberate declaration, and selection honors it ahead of
    // the values — so explain has to say what selection will do, not what the
    // values alone would.
    const cwd = project(
      { 'covsel.json': '{}\n' },
      { entries: [covered], config: recordedConfig(config) },
    );

    const r = await explainPath({
      cwd,
      config: { ...config, sentinels: ['covsel.json'] },
      path: 'covsel.json',
    });

    expect(r.forcesFullRun?.always).toBe(true);
    expect(r.forcesFullRun?.why).toContain('sentinel');
  });

  it('reports a path under an excluded directory as one discovery never sees', async () => {
    const cwd = project(
      { 'node_modules/pkg/index.test.js': '', 'src/math.js': MATH },
      { entries: [covered] },
    );

    const r = await explainPath({ cwd, config, path: 'node_modules/pkg/index.test.js' });

    expect(r.ok).toBe(true);
    expect(r.excluded).toBe(true);
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
    expect(r.mapState).toBe('absent');
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

  it('refuses the repository root as the directory it is', async () => {
    const cwd = project({ 'src/math.js': MATH }, { entries: [covered] });

    const r = await explainPath({ cwd, config, path: '.' });

    expect(r.ok).toBe(false);
    expect(r.error).toContain('directory');
  });
});

/**
 * What `explain` says about a path is only useful if it agrees with what the
 * next selection will do. These build a real work tree, because the states where
 * the two can disagree — an unanchored map, a map that measured nothing — are
 * exactly the ones a developer is in when they come to ask.
 */
describe('explain: what the next selection would do', () => {
  /** A git repo holding `files`, all committed, with `entries` recorded against HEAD. */
  function repo(files: Record<string, string>, entries: MapEntry[]): string {
    const cwd = project(files);
    commitAll(cwd);
    const commit = gitHeadCommit(cwd);
    mkdirSync(join(cwd, '.covsel'), { recursive: true });
    writeFileSync(
      join(cwd, '.covsel', 'map.json'),
      JSON.stringify({
        schemaVersion: MAP_SCHEMA_VERSION,
        granularity: 'file',
        ...(commit !== undefined ? { commit } : {}),
        recordedAt: '2026-07-01T00:00:00.000Z',
        sentinelHashes: {},
        observed: ['**'],
        entries,
      }),
    );
    return cwd;
  }

  it('reports that the next selection narrows when the map can be trusted', async () => {
    const cwd = repo({ 'src/math.js': MATH, 'test/add.test.js': '' }, [covered]);

    const r = await explainPath({ cwd, config, path: 'src/math.js' });

    expect(r.nextIsFullRun).toBe(false);
  });

  it('does not let a map that measured nothing read as "selects nothing"', async () => {
    const cwd = repo({ 'src/lonely.js': 'export const x = 1;\n' }, []);

    const r = await explainPath({ cwd, config, path: 'src/lonely.js' });
    const selection = await selectAffected({ cwd, config });

    expect(r.source?.coveredBy).toEqual([]);
    // Nothing covers it, and yet every test runs: the empty entry list is what
    // the fail-open policy refuses to read as a measurement.
    expect(selection.fullRun).toBe(true);
    expect(r.nextIsFullRun).toBe(true);
    expect(r.nextFullRunReason).toContain('no entries');
  });

  it('does not let an unanchored map read as "selects nothing"', async () => {
    const cwd = project({ 'src/lonely.js': 'export const x = 1;\n' });
    commitAll(cwd);
    mkdirSync(join(cwd, '.covsel'), { recursive: true });
    writeFileSync(
      join(cwd, '.covsel', 'map.json'),
      JSON.stringify({
        schemaVersion: MAP_SCHEMA_VERSION,
        granularity: 'file',
        recordedAt: '2026-07-01T00:00:00.000Z',
        sentinelHashes: {},
        observed: ['**'],
        entries: [covered],
      }),
    );

    const r = await explainPath({ cwd, config, path: 'src/lonely.js' });
    const selection = await selectAffected({ cwd, config });

    expect(selection.fullRun).toBe(true);
    expect(r.nextIsFullRun).toBe(true);
    expect(r.nextFullRunReason).toContain('no commit');
  });
});

/**
 * The guard that matters most: a block `explain` calls uncovered must be one a
 * change to could not select its tests. Recorded and selected for real, because
 * the disagreement this catches lives between the recorded hashes and the ones
 * the file has now.
 */
describe('explain: agrees with what selection does', () => {
  it('never calls a block uncovered when editing it selects a test', async () => {
    const cwd = project({
      'src/math.mjs': MATH,
      'test/add.test.mjs':
        "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n" +
        "import { add } from '../src/math.mjs';\ntest('adds', () => assert.equal(add(1, 1), 2));\n",
      'package.json':
        '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
      '.gitignore': '.covsel/\n',
    });
    commitAll(cwd);
    const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
    expect((await recordMap({ cwd, config, recorder })).ok).toBe(true);

    // Edit the body of the function the test executes. Its recorded hash is now
    // gone from the file, which is what makes the change select the test.
    writeFileSync(
      join(cwd, 'src/math.mjs'),
      MATH.replace('return a + b;', 'return b + a;'),
    );

    const r = await explainPath({ cwd, config, path: 'src/math.mjs' });
    const selection = await selectAffected({ cwd, config });

    expect(selection.fullRun).toBe(false);
    expect(selection.tests).toContain('test/add.test.mjs');
    const add = (r.source?.blocks ?? []).find((b) => b.name === 'add');
    expect(['covered', 'file-level', 'unmatched']).toContain(add?.verdict);
  }, 60_000);
});
