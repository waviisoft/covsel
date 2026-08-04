import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverTestFiles, resolveConfig } from '@covsel/core';

import { outcomeMisses } from '../src/metrics.js';
import { collectOutcomes } from '../src/outcomes.js';
import { parseProject } from '../src/project.js';
import { measure } from '../src/replay.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COVSEL_BIN = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');

// The harness drives the covsel CLI as a user would, so it needs the build. CI
// builds before it tests; a local run that has not may skip this one.
const built = existsSync(COVSEL_BIN);

const project = parseProject(
  {
    name: 'fixture',
    repo: 'covsel/fixture',
    ref: 'unused-here',
    adapter: '@covsel/adapter-generic',
    adapterName: 'generic',
    install: ['true'],
    runner: [process.execPath, '--test'],
    covsel: { sourceGlobs: ['lib/**/*.mjs'] },
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
  if (!built) return;
  repo = mkdtempSync(join(tmpdir(), 'covsel-bench-replay-'));

  write('lib/a.mjs', 'export const add = (x, y) => x + y\n');
  write('lib/b.mjs', 'export const mul = (x, y) => x * y\n');
  write(
    'test/a.test.mjs',
    "import { test } from 'node:test'\n" +
      "import assert from 'node:assert'\n" +
      "import { add } from '../lib/a.mjs'\n" +
      "test('add', () => assert.strictEqual(add(1, 2), 3))\n",
  );
  write(
    'test/b.test.mjs',
    "import { test } from 'node:test'\n" +
      "import assert from 'node:assert'\n" +
      "import { mul } from '../lib/b.mjs'\n" +
      "test('mul', () => assert.strictEqual(mul(2, 3), 6))\n",
  );
  write('package.json', '{ "name": "fixture", "private": true, "type": "module" }\n');
  write('covsel.json', `${JSON.stringify(project.covsel, null, 2)}\n`);
  write('.gitignore', '.covsel/\nnode_modules/\n');

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

interface Prepared {
  base: string;
  head: string;
  recordMs: number;
  baseOutcomes: ReturnType<typeof collectOutcomes>;
}

/** Record at the base, note what each test did there, then commit the change. */
function prepare(change: () => void): Prepared {
  const base = git(['rev-parse', 'HEAD']);

  const started = process.hrtime.bigint();
  const record = spawnSync(
    process.execPath,
    [COVSEL_BIN, 'record', '--adapter', 'generic', '--', ...project.runner],
    { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const recordMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (record.status !== 0) throw new Error(`record failed: ${record.stderr ?? ''}`);

  const baseOutcomes = collectOutcomes({
    command: project.runner,
    cwd: repo,
    files: discoverTestFiles(repo, resolveConfig(project.covsel)),
  });

  change();
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'change']);
  const head = git(['rev-parse', 'HEAD']);
  git(['checkout', '--quiet', base]);

  return { base, head, recordMs, baseOutcomes };
}

describe.skipIf(!built)('measure', () => {
  it('selects only the test covering the changed source, and misses nothing', () => {
    const { base, head, recordMs, baseOutcomes } = prepare(() => {
      write('lib/a.mjs', 'export const add = (x, y) => x + y + 1\n');
    });

    const result = measure({
      project,
      repo,
      base,
      head,
      covselBin: COVSEL_BIN,
      recordMs,
      baseOutcomes,
    });

    expect(result.misses).toEqual([]);
    expect(result.outcomesChanged).toEqual(['test/a.test.mjs']);
    expect(result.selectedTests).toBe(1);
    expect(result.totalTests).toBe(2);
    expect(result.selectionRatio).toBe(0.5);
    expect(result.fullRun).toBe(false);
  }, 120_000);

  it('reports a change that altered no outcome as a clean, narrow selection', () => {
    const { base, head, recordMs, baseOutcomes } = prepare(() => {
      write('lib/a.mjs', 'export const add = (x, y) => x + y // harmless\n');
    });

    const result = measure({
      project,
      repo,
      base,
      head,
      covselBin: COVSEL_BIN,
      recordMs,
      baseOutcomes,
    });

    expect(result.outcomesChanged).toEqual([]);
    expect(result.misses).toEqual([]);
    expect(result.selectedTests).toBeLessThan(result.totalTests);
  }, 120_000);

  // The whole point of the harness: if covsel ever stops running a test whose
  // behaviour a change altered, this is the number that has to move.
  it('records a miss when selection leaves out a test the change broke', () => {
    const { base, head, recordMs, baseOutcomes } = prepare(() => {
      write('lib/a.mjs', 'export const add = (x, y) => x + y + 1\n');
    });

    const result = measure({
      project,
      repo,
      base,
      head,
      covselBin: COVSEL_BIN,
      recordMs,
      baseOutcomes,
    });
    expect(result.outcomesChanged).toContain('test/a.test.mjs');

    // Same run, scored against a selection that left the broken test out.
    const headOutcomes = collectOutcomes({
      command: project.runner,
      cwd: repo,
      files: ['test/a.test.mjs', 'test/b.test.mjs'],
    });
    expect(outcomeMisses(baseOutcomes, headOutcomes, ['test/b.test.mjs'])).toEqual([
      'test/a.test.mjs',
    ]);
  }, 120_000);

  // A failed `affected` prints no files, which looks exactly like a correct
  // empty selection -- and an empty selection misses nothing, so the failure
  // would score as a flawless result. Refusing to score it is the guard.
  it('refuses to score a run where covsel itself failed', () => {
    const { base, head, recordMs, baseOutcomes } = prepare(() => {
      write('lib/a.mjs', 'export const add = (x, y) => x + y + 1\n');
    });

    expect(() =>
      measure({
        project,
        repo,
        base,
        head,
        covselBin: join(REPO_ROOT, 'packages', 'cli', 'dist', 'no-such-entry.js'),
        recordMs,
        baseOutcomes,
      }),
    ).toThrow(/covsel affected failed/);
  }, 120_000);

  it('counts a full run as selecting the whole suite, not as selecting nothing', () => {
    const { base, head, recordMs, baseOutcomes } = prepare(() => {
      // package.json is a sentinel: changing it invalidates the map.
      write(
        'package.json',
        '{ "name": "fixture2", "private": true, "type": "module" }\n',
      );
    });

    const result = measure({
      project,
      repo,
      base,
      head,
      covselBin: COVSEL_BIN,
      recordMs,
      baseOutcomes,
    });

    expect(result.fullRun).toBe(true);
    expect(result.selectedTests).toBe(result.totalTests);
    expect(result.selectionRatio).toBe(1);
    expect(result.misses).toEqual([]);
  }, 120_000);
});
