import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeStatus,
  type CoverageMap,
  createGenericRecorder,
  explainPath,
  hashFileContents,
  OBSERVES_EVERYTHING,
  type RecordEvent,
  recordMap,
  type Recorder,
  resolveConfig,
  selectAffected,
} from '../src/index.js';
import { commitAll, git, write } from './helpers/repo.js';

/**
 * An entry that exists and credits nothing.
 *
 * covsel already refuses to read "the map says nothing about this test" as
 * "this test covers nothing": a discovered test file with no entry always runs.
 * An entry crediting zero sources is the same claim in a different shape, and
 * it used to be read the second way — no changed path can match an empty file
 * list, so the test was never selected by anything, and nothing said so.
 *
 * It is not a rare shape. A test that drives its subject in a child process, a
 * worker, or a browser records nothing at all under a recorder whose coverage
 * mechanism does not reach there, and that blind spot belongs to the test
 * rather than to the recorder, so the recorder's `observed` globs cannot
 * express it. The fixture below is that test: one that exercises its source
 * only through a child process.
 */

const config = resolveConfig();

const ADD = 'export function add(a, b) {\n  return a + b;\n}\n';
// Run as a script by the test below, never imported into the test's own process.
const GREET = "const greet = () => 'hi';\nprocess.stdout.write(greet());\n";

let cwd: string;

const mapPath = (): string => join(cwd, config.store.dir, 'map.json');
const readMap = (): CoverageMap => JSON.parse(readFileSync(mapPath(), 'utf8'));
const writeMap = (map: CoverageMap): void =>
  writeFileSync(mapPath(), JSON.stringify(map));

/**
 * Empty out what one test's entry credits, leaving the entry in place. This is
 * the map an adapter blind to a child process writes; the fixture records with
 * the generic recorder, which inherits `NODE_V8_COVERAGE` into the child and so
 * sees everything.
 */
function creditNothing(map: CoverageMap, testFile: string): void {
  const entry = map.entries.find((e) => e.test.file === testFile);
  if (entry === undefined) throw new Error(`no entry for ${testFile}`);
  entry.files = [];
  delete entry.blocks;
}

/** A recorder that credits exactly what it is told to, for the files it is told. */
function fixedRecorder(covered: Record<string, string[]>): Recorder {
  return {
    observes: OBSERVES_EVERYTHING,
    async record(testFile: string) {
      const files = (covered[testFile] ?? []).map((file) => ({
        file,
        fileHash: hashFileContents(join(cwd, file)),
      }));
      return [{ test: { file: testFile }, files, blocks: [] }];
    },
  };
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-unmeasured-'));
  write(cwd, 'src/a.mjs', ADD);
  write(cwd, 'src/child.mjs', GREET);
  write(
    cwd,
    'test/a.test.mjs',
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n" +
      "import { add } from '../src/a.mjs';\ntest('adds', () => assert.equal(add(1, 1), 2));\n",
  );
  // The test the issue is about: its subject runs in a child process, so a
  // recorder that watches only its own process records nothing for it.
  write(
    cwd,
    'test/child.test.mjs',
    "import assert from 'node:assert/strict';\nimport { spawnSync } from 'node:child_process';\n" +
      "import { test } from 'node:test';\ntest('the child works', () => {\n" +
      "  const res = spawnSync(process.execPath, ['src/child.mjs'], { encoding: 'utf8' });\n" +
      "  assert.equal(res.stdout, 'hi');\n});\n",
  );
  write(
    cwd,
    'package.json',
    '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
  );
  write(cwd, '.gitignore', '.covsel/\n');
  commitAll(cwd, 'base');

  const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
  expect((await recordMap({ cwd, config, recorder })).ok).toBe(true);
}, 60_000);

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

/** Commit a change to a source file, as a developer would before selecting. */
function change(rel: string, content: string): void {
  write(cwd, rel, content);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', `change ${rel}`]);
}

describe('selection with an entry that credits nothing', () => {
  it('runs the test whose entry credits nothing when the code it drives changes', async () => {
    const map = readMap();
    creditNothing(map, 'test/child.test.mjs');
    writeMap(map);

    change('src/child.mjs', `${GREET}// changed\n`);

    const result = await selectAffected({ cwd, config });
    // Not by falling open: the entry that measured something still narrows.
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/child.test.mjs']);
  });

  it('runs it for a change it recorded nothing about at all', async () => {
    const map = readMap();
    creditNothing(map, 'test/child.test.mjs');
    writeMap(map);

    change('src/a.mjs', `${ADD}// changed\n`);

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs', 'test/child.test.mjs']);
  });

  it('runs the whole file when one recorded unit of it credits nothing', async () => {
    // A per-test recorder yields one unit per test, and only one of them may be
    // the blind one. Selecting just that unit would trust a file the recorder
    // has already shown it cannot fully see, so the file runs whole.
    const map = readMap();
    const entry = map.entries.find((e) => e.test.file === 'test/a.test.mjs')!;
    entry.test = { file: 'test/a.test.mjs', name: 'adds' };
    map.entries.push({
      test: { file: 'test/a.test.mjs', name: 'drives a child' },
      files: [],
    });
    writeMap(map);

    change('src/child.mjs', `${GREET}// changed\n`);

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toContain('test/a.test.mjs');
    expect(result.selected).toContainEqual({ file: 'test/a.test.mjs' });
    // Whole file, not the blind unit alone.
    expect(result.selected.filter((u) => u.file === 'test/a.test.mjs')).toHaveLength(1);
  });

  it('runs on every selection, without dragging the measured tests along', async () => {
    // Nothing changed at all. An unmapped discovered test runs here too -- the
    // map has no opinion to wait for -- and this is the same position. What it
    // must not do is cost the tests the map did measure.
    const map = readMap();
    creditNothing(map, 'test/child.test.mjs');
    writeMap(map);

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/child.test.mjs']);
  });
});

describe('recording an entry that credits nothing', () => {
  it('names the test as it is recorded and in the result', async () => {
    const events: RecordEvent[] = [];
    const result = await recordMap({
      cwd,
      config,
      recorder: fixedRecorder({ 'test/a.test.mjs': ['src/a.mjs'] }),
      onEvent: (e) => events.push(e),
    });

    // The map is still written: a test that genuinely covers nothing is legal,
    // and refusing the recording would leave the project with no map at all.
    expect(result.ok).toBe(true);
    expect(result.unmeasured).toEqual([{ file: 'test/child.test.mjs' }]);

    const measured = events.find((e) => e.file === 'test/a.test.mjs');
    expect(measured?.unmeasured ?? 0).toBe(0);
    const blind = events.find((e) => e.file === 'test/child.test.mjs');
    expect(blind?.sources).toBe(0);
    expect(blind?.unmeasured).toBe(1);
  });
});

describe('reporting an entry that credits nothing', () => {
  it('is counted by status rather than folded into the entry count', async () => {
    const map = readMap();
    creditNothing(map, 'test/child.test.mjs');
    writeMap(map);

    const status = await computeStatus({ cwd, config });
    expect(status.entryCount).toBe(2);
    expect(status.unmeasuredEntryCount).toBe(1);
  });

  it('is what explain says about the test', async () => {
    const map = readMap();
    creditNothing(map, 'test/child.test.mjs');
    writeMap(map);

    const explained = await explainPath({ cwd, config, path: 'test/child.test.mjs' });
    expect(explained.ok).toBe(true);
    // Recorded, so not the unmapped case -- and still always run.
    expect(explained.test?.unrecorded).toBe(false);
    expect(explained.test?.unmeasured).toBe(true);

    const other = await explainPath({ cwd, config, path: 'test/a.test.mjs' });
    expect(other.test?.unmeasured).toBe(false);
  });
});
