import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  type CoverageMap,
  createGenericRecorder,
  FileSelector,
  recordMap,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * Block-hash granularity: two tests cover the same source file but execute
 * different functions, so editing one function must select only the test that
 * ran it — while every fail-open guarantee still holds (a block a test executed
 * changing always selects it; reformatting selects nothing).
 */

const config = resolveConfig();

const MATH = `export function add(a, b) {
  return a + b;
}

export function sub(a, b) {
  return a - b;
}
`;

const FILES: Record<string, string> = {
  'src/math.mjs': MATH,
  'test/add.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/math.mjs';\ntest('add', () => assert.equal(add(2, 3), 5));\n`,
  'test/sub.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sub } from '../src/math.mjs';\ntest('sub', () => assert.equal(sub(3, 2), 1));\n`,
  'package.json': `{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n`,
  '.gitignore': `.covsel/\n`,
};

let cwd: string;
let recordedMap: CoverageMap;
let mapBackup: string;

function git(args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function write(rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function reset(): void {
  git(['checkout', '--', '.']);
  git(['clean', '-fd']);
  writeFileSync(join(cwd, config.store.dir, 'map.json'), mapBackup);
}

beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-block-'));
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'fixture']);

  const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
  const result = await recordMap({ cwd, config, recorder });
  expect(result.ok).toBe(true);
  recordedMap = result.map!;
  mapBackup = JSON.stringify(recordedMap, null, 2);
}, 60_000);

afterEach(() => reset());
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe('block recording', () => {
  it('records at block granularity with per-test block sets', () => {
    expect(recordedMap.granularity).toBe('block');
    for (const entry of recordedMap.entries) {
      expect(entry.blocks && entry.blocks.length).toBeGreaterThan(0);
    }
  });

  it('does not attribute an unexecuted function to a test', () => {
    // add.test runs add (not sub); sub.test runs sub (not add). Both load the
    // module, so both share the module block — but not each other's function.
    const addBlocks = recordedMap.entries.find(
      (e) => e.test.file === 'test/add.test.mjs',
    )!.blocks!;
    const subBlocks = recordedMap.entries.find(
      (e) => e.test.file === 'test/sub.test.mjs',
    )!.blocks!;
    const addHashes = new Set(addBlocks.map((b) => b.blockHash));
    const subHashes = new Set(subBlocks.map((b) => b.blockHash));
    // The two entries share exactly the module block for math.mjs.
    const shared = [...addHashes].filter((h) => subHashes.has(h));
    expect(shared).toHaveLength(1);
    // Each has a private block (its own function) the other lacks.
    expect(addHashes.size).toBeGreaterThan(shared.length);
    expect(subHashes.size).toBeGreaterThan(shared.length);
  });
});

describe('block-level selection', () => {
  it('precision: editing add() selects only add.test', async () => {
    write('src/math.mjs', MATH.replace('a + b', 'a + b + 0'));
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/add.test.mjs']);
  });

  it('precision: editing sub() selects only sub.test', async () => {
    write('src/math.mjs', MATH.replace('a - b', 'a - b - 0'));
    const result = await selectAffected({ cwd, config });
    expect(result.tests).toEqual(['test/sub.test.mjs']);
  });

  it('a top-level edit selects every test covering the file', async () => {
    write('src/math.mjs', `const BASE = 0;\n${MATH}`);
    const result = await selectAffected({ cwd, config });
    expect(result.tests).toEqual(['test/add.test.mjs', 'test/sub.test.mjs']);
  });

  it('a pure reformat selects nothing', async () => {
    const reformatted = MATH.replace(/\n/g, '\n\n').replace(
      'return a + b',
      '    return a + b',
    );
    write('src/math.mjs', reformatted);
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual([]);
  });

  it('block mutation guard: changing any block a test executed selects that test', async () => {
    const selector = new FileSelector();
    for (const entry of recordedMap.entries) {
      for (const block of entry.blocks ?? []) {
        const selected = await selector.affected(recordedMap, [
          { file: block.file, kind: 'modified', changedBlockHashes: [block.blockHash] },
        ]);
        expect(
          selected.map((t) => t.file),
          `changing a block of ${block.file} must select ${entry.test.file}`,
        ).toContain(entry.test.file);
      }
    }
  });
});
