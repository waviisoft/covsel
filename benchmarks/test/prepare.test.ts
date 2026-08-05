import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordMap, writeCovselConfig } from '../src/prepare.js';
import { parseProject } from '../src/project.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COVSEL_BIN = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');
const built = existsSync(COVSEL_BIN);

const project = parseProject(
  {
    name: 'fixture',
    repo: 'covsel/fixture',
    // A real-shaped SHA; the fixture's own commits are what these tests use.
    ref: '0000000000000000000000000000000000000000',
    adapter: '@covsel/adapter-generic',
    adapterName: 'generic',
    install: ['true'],
    runner: [process.execPath, '--test'],
    covsel: { testGlobs: ['test/**/*.test.mjs'], sourceGlobs: ['lib/**/*.mjs'] },
  },
  'fixture.json',
);

let repo: string;

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}

function write(rel: string, contents: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'covsel-bench-prepare-'));
  write('lib/a.mjs', 'export const add = (x, y) => x + y\n');
  write(
    'test/a.test.mjs',
    "import { test } from 'node:test'\n" +
      "import assert from 'node:assert'\n" +
      "import { add } from '../lib/a.mjs'\n" +
      "test('add', () => assert.strictEqual(add(1, 2), 3))\n",
  );
  write('package.json', '{ "name": "fixture", "private": true, "type": "module" }\n');
  write('.gitignore', 'node_modules/\n');

  const scope = join(repo, 'node_modules', '@covsel');
  mkdirSync(scope, { recursive: true });
  for (const name of ['core', 'adapter-generic']) {
    spawnSync('ln', ['-sfn', join(REPO_ROOT, 'packages', name), join(scope, name)]);
  }

  git(['init', '--quiet', '-b', 'main']);
  git(['config', 'user.email', 'benchmarks@example.com']);
  git(['config', 'user.name', 'covsel benchmarks']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'base']);
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('writeCovselConfig', () => {
  // Recording refuses to anchor a map to a commit when the tree has anything
  // uncommitted, untracked files included, and an unanchored map falls open. A
  // config file merely written would therefore make every replay a full run --
  // which passes every miss check, because covsel ran everything.
  it('leaves the work tree clean, so the map can still be anchored', () => {
    writeCovselConfig(repo, project);
    expect(existsSync(join(repo, 'covsel.json'))).toBe(true);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('keeps the recorded map out of the tree as well', () => {
    writeCovselConfig(repo, project);
    mkdirSync(join(repo, '.covsel'), { recursive: true });
    write('.covsel/map.json', '{}\n');
    expect(git(['status', '--porcelain'])).toBe('');
  });
});

describe.skipIf(!built)('recordMap', () => {
  it('records a map that can select', () => {
    writeCovselConfig(repo, project);
    const ms = recordMap({
      project,
      repo,
      covselBin: COVSEL_BIN,
      timeoutMs: 120_000,
    });
    expect(ms).toBeGreaterThan(0);
  }, 120_000);

  // The guard that turns the harness's most flattering failure into a loud one.
  it('refuses a map that cannot select, rather than measuring from it', () => {
    // The config written the naive way: present, but never hidden from git, so
    // the tree is dirty and the map comes out unanchored.
    writeFileSync(
      join(repo, 'covsel.json'),
      `${JSON.stringify(project.covsel, null, 2)}\n`,
    );
    expect(git(['status', '--porcelain'])).not.toBe('');

    expect(() =>
      recordMap({ project, repo, covselBin: COVSEL_BIN, timeoutMs: 120_000 }),
    ).toThrow(/cannot select/);
  }, 120_000);
});
