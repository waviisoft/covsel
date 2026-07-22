import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordMap, resolveConfig, selectAffected } from '@covsel/core';
import { createNodeTestRecorder, runNodeTestSelection } from '../src/index.js';

/**
 * Per-test selection for node:test: two tests live in one test file but execute
 * different source files, so editing one source must select only the test that
 * ran it — and running the selection must execute only that test. The recorder
 * spawns a shim that imports the built core, so this suite depends on
 * `@covsel/core` being built.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const config = resolveConfig();

const MATH = 'export function add(a, b) {\n  return a + b;\n}\n';
const FILES: Record<string, string> = {
  'src/math.mjs': MATH,
  'src/greet.mjs': 'export function hello(n) {\n  return `hi ${n}`;\n}\n',
  'suite.test.mjs': [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "import { add } from './src/math.mjs';",
    "import { hello } from './src/greet.mjs';",
    "test('math test', () => {",
    "  appendFileSync('markers.txt', 'math test\\n');",
    '  assert.equal(add(2, 3), 5);',
    '});',
    "test('greet test', () => {",
    "  appendFileSync('markers.txt', 'greet test\\n');",
    "  assert.equal(hello('x'), 'hi x');",
    '});',
    '',
  ].join('\n'),
  'package.json': '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
  '.gitignore': '.covsel/\nmarkers.txt\n',
};

let cwd: string;

function git(args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function write(rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(async () => {
  if (!existsSync(coreDist)) {
    execSync('pnpm --filter @covsel/core build', { cwd: repoRoot, stdio: 'ignore' });
  }
  cwd = mkdtempSync(join(tmpdir(), 'covsel-pertest-'));
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'fixture']);

  const recorder = createNodeTestRecorder({ command: ['node', '--test'], cwd, config });
  const result = await recordMap({ cwd, config, recorder });
  expect(result.ok).toBe(true);
}, 120_000);

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function entry(name: string) {
  const map = JSON.parse(
    readFileSync(join(cwd, config.store.dir, 'map.json'), 'utf8'),
  ) as {
    entries: { test: { file: string; name?: string }; files: { file: string }[] }[];
  };
  return map.entries.find((e) => e.test.name === name);
}

describe('node:test per-test recording', () => {
  it('records one entry per test, each with the sources that test executed', () => {
    expect(entry('math test')?.files.map((f) => f.file)).toEqual(['src/math.mjs']);
    expect(entry('greet test')?.files.map((f) => f.file)).toEqual(['src/greet.mjs']);
  });
});

describe('node:test per-test selection', () => {
  it('editing one source selects only the test that ran it', async () => {
    write('src/math.mjs', `${MATH}// edit\n`);
    try {
      const result = await selectAffected({ cwd, config });
      const names = result.selected.map((t) => `${t.file}:${t.name ?? '*'}`);
      expect(names).toContain('suite.test.mjs:math test');
      expect(names).not.toContain('suite.test.mjs:greet test');
      expect(result.tests).toEqual(['suite.test.mjs']);

      // Running the selection executes only the affected test.
      rmSync(join(cwd, 'markers.txt'), { force: true });
      const code = runNodeTestSelection({
        selected: result.selected,
        command: ['node', '--test'],
        cwd,
        stdio: 'ignore',
      });
      expect(code).toBe(0);
      const markers = readFileSync(join(cwd, 'markers.txt'), 'utf8')
        .trim()
        .split('\n')
        .sort();
      expect(markers).toEqual(['math test']);
    } finally {
      git(['checkout', '--', 'src/math.mjs']);
    }
  }, 30_000);
});
