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

import { recordMap, resolveConfigFor, selectAffected } from '@covsel/core';

import { createMochaRecorder, mochaAdapter, runMochaSelection } from '../src/index.js';

/**
 * Per-test selection for Mocha: several tests live in one spec file but execute
 * different sources, so editing one source must select only the test that ran
 * it — and running the selection must drive Mocha to that one test. The recorder
 * spawns a shim that imports the built core, so this suite depends on
 * `@covsel/core` being built.
 *
 * Mocha is not a dependency of this package; the fixture borrows the copy the
 * Mocha example installs.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const mochaBin = fileURLToPath(
  new URL('../../../examples/mocha-basic/node_modules/.bin/mocha', import.meta.url),
);
const config = resolveConfigFor(mochaAdapter);

const MATH = 'export function add(a, b) {\n  return a + b;\n}\n';
const EXTRA = 'export function extra(x) {\n  return x + 0;\n}\n';

/** A test body that records that it ran, then exercises one source. */
const unit = (title: string, label: string, body: string) =>
  [
    `  it('${title}', () => {`,
    `    appendFileSync('markers.txt', '${label}\\n');`,
    `    ${body}`,
    '  });',
  ].join('\n');

const FILES: Record<string, string> = {
  'src/math.mjs': MATH,
  'src/greet.mjs': 'export function hello(n) {\n  return `hi ${n}`;\n}\n',
  'src/tricky.mjs': 'export function tricky(x) {\n  return x * 2;\n}\n',
  'src/twice.mjs': 'export function twice(x) {\n  return x * 2;\n}\n',
  'src/extra.mjs': EXTRA,
  'test/suite.test.mjs': [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { add } from '../src/math.mjs';",
    "import { hello } from '../src/greet.mjs';",
    "import { tricky } from '../src/tricky.mjs';",
    "describe('math', () => {",
    unit('adds', 'suite:math adds', 'assert.equal(add(2, 3), 5);'),
    '});',
    "describe('greet', () => {",
    unit('greets', 'suite:greet greets', "assert.equal(hello('x'), 'hi x');"),
    '});',
    // A title full of regex syntax, so the run filter has to escape it rather
    // than compile a valid pattern that matches nothing.
    "describe('regex', () => {",
    unit(
      'handles a+b (finally)',
      'suite:regex handles a+b (finally)',
      'assert.equal(tricky(2), 4);',
    ),
    '});',
    '',
  ].join('\n'),
  // Its first test shares a full title with one in suite.test.mjs, which is
  // what a single --grep over both files cannot tell apart.
  'test/other.test.mjs': [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { twice } from '../src/twice.mjs';",
    "import { extra } from '../src/extra.mjs';",
    "describe('math', () => {",
    unit('adds', 'other:math adds', 'assert.equal(twice(2), 4);'),
    '});',
    "describe('other', () => {",
    unit('adds up', 'other:other adds up', 'assert.equal(extra(1), 1);'),
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

/** Which tests a run executed, in the order they wrote their marker. */
function markers(): string[] {
  const path = join(cwd, 'markers.txt');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .sort();
}

/** Run a selection through the adapter, from a clean marker file. */
function runSelection(selected: { file: string; name?: string }[]): number {
  rmSync(join(cwd, 'markers.txt'), { force: true });
  return runMochaSelection({
    selected,
    command: [mochaBin],
    cwd,
    stdio: 'ignore',
  });
}

beforeAll(async () => {
  if (!existsSync(coreDist)) {
    execSync('pnpm --filter @covsel/core build', { cwd: repoRoot, stdio: 'ignore' });
  }
  cwd = mkdtempSync(join(tmpdir(), 'covsel-mocha-'));
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'fixture']);

  const recorder = createMochaRecorder({ command: [mochaBin], cwd, config });
  const result = await recordMap({ cwd, config, recorder });
  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
}, 180_000);

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function entry(file: string, name: string) {
  const map = JSON.parse(
    readFileSync(join(cwd, config.store.dir, 'map.json'), 'utf8'),
  ) as {
    entries: { test: { file: string; name?: string }; files: { file: string }[] }[];
  };
  return map.entries.find((e) => e.test.file === file && e.test.name === name);
}

describe('mocha per-test recording', () => {
  it('records one entry per test, named by the full title --grep matches', () => {
    expect(entry('test/suite.test.mjs', 'math adds')?.files.map((f) => f.file)).toEqual([
      'src/math.mjs',
    ]);
    expect(
      entry('test/suite.test.mjs', 'greet greets')?.files.map((f) => f.file),
    ).toEqual(['src/greet.mjs']);
    expect(
      entry('test/suite.test.mjs', 'regex handles a+b (finally)')?.files.map(
        (f) => f.file,
      ),
    ).toEqual(['src/tricky.mjs']);
    expect(
      entry('test/other.test.mjs', 'other adds up')?.files.map((f) => f.file),
    ).toEqual(['src/extra.mjs']);
  });

  it('records per test even when the project runs Mocha in parallel', async () => {
    // Mocha's parallel workers run the root hooks in a process that is not the
    // one covsel reads the result from, so a recording left in parallel mode
    // comes back empty -- a map crediting nothing, from a run that looked fine.
    const recorder = createMochaRecorder({
      command: [mochaBin, '--parallel'],
      cwd,
      config,
    });
    const units = await recorder.record('test/other.test.mjs');
    expect(units.map((u) => u.test.name).sort()).toEqual(['math adds', 'other adds up']);
  }, 60_000);
});

describe('mocha per-test selection', () => {
  it('editing one source selects and runs only the test that ran it', async () => {
    write('src/math.mjs', `${MATH}// edit\n`);
    try {
      const result = await selectAffected({ cwd, config });
      const names = result.selected.map((t) => `${t.file}:${t.name ?? '*'}`);
      expect(names).toContain('test/suite.test.mjs:math adds');
      expect(names).not.toContain('test/suite.test.mjs:greet greets');
      expect(result.tests).toEqual(['test/suite.test.mjs']);

      expect(runSelection(result.selected)).toBe(0);
      expect(markers()).toEqual(['suite:math adds']);
    } finally {
      git(['checkout', '--', 'src/math.mjs']);
    }
  }, 60_000);

  it('runs a test whose name is full of regex metacharacters', async () => {
    write('src/tricky.mjs', 'export function tricky(x) {\n  return x * 2 + 0;\n}\n');
    try {
      const result = await selectAffected({ cwd, config });
      expect(result.selected.map((t) => t.name)).toEqual(['regex handles a+b (finally)']);

      // The failure this guards is silent: an unescaped `a+b (finally)` is a
      // valid pattern that matches no title at all, so Mocha exits 0 having run
      // nothing and the affected test is skipped.
      expect(runSelection(result.selected)).toBe(0);
      expect(markers()).toEqual(['suite:regex handles a+b (finally)']);
    } finally {
      git(['checkout', '--', 'src/tricky.mjs']);
    }
  }, 60_000);

  it('lets a shared test name over-run, never miss an affected test', async () => {
    // Two files hold a test called "math adds"; one --grep over both cannot
    // tell them apart. The rule is that the extra one may run, and neither
    // affected test may be left out.
    write('src/math.mjs', `${MATH}// edit\n`);
    write('src/extra.mjs', `${EXTRA}// edit\n`);
    try {
      const result = await selectAffected({ cwd, config });
      const selected = result.selected.map((t) => `${t.file}:${t.name ?? '*'}`);
      expect(selected.sort()).toEqual([
        'test/other.test.mjs:other adds up',
        'test/suite.test.mjs:math adds',
      ]);

      expect(runSelection(result.selected)).toBe(0);
      const ran = markers();
      expect(ran).toContain('suite:math adds');
      expect(ran).toContain('other:other adds up');
      // Everything that ran shares its name with something selected: the
      // duplicate is allowed through, an unrelated test is not.
      const selectedNames = new Set(result.selected.map((t) => t.name));
      for (const marker of ran) {
        expect(selectedNames.has(marker.split(':').slice(1).join(':'))).toBe(true);
      }
      expect(ran).not.toContain('suite:greet greets');
    } finally {
      git(['checkout', '--', 'src/math.mjs', 'src/extra.mjs']);
    }
  }, 60_000);

  it('runs a changed spec file in full, with no name filter', async () => {
    write('test/suite.test.mjs', `${FILES['test/suite.test.mjs']}// edit\n`);
    try {
      const result = await selectAffected({ cwd, config });
      expect(result.selected).toContainEqual({ file: 'test/suite.test.mjs' });

      expect(runSelection(result.selected)).toBe(0);
      expect(markers()).toEqual([
        'suite:greet greets',
        'suite:math adds',
        'suite:regex handles a+b (finally)',
      ]);
    } finally {
      git(['checkout', '--', 'test/suite.test.mjs']);
    }
  }, 60_000);
});
