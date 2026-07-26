import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createGenericRecorder,
  recordMap,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * A map describes the repository at the commit it was recorded on, so selection
 * has to measure change from *that* commit. Diffing only from the merge-base
 * with the default branch silently ignores everything committed since the map
 * was recorded — which is exactly what CI does when it restores a map published
 * on the default branch onto a later commit, and would skip tests whose code
 * changed in between.
 */

const config = resolveConfig();
const ADD = 'export function add(a, b) {\n  return a + b;\n}\n';

let cwd: string;

function git(args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function write(rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-stale-'));
  write('src/a.mjs', ADD);
  write(
    'test/a.test.mjs',
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n" +
      "import { add } from '../src/a.mjs';\ntest('adds', () => assert.equal(add(1, 1), 2));\n",
  );
  write(
    'package.json',
    '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
  );
  write('.gitignore', '.covsel/\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);

  const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
  const result = await recordMap({ cwd, config, recorder });
  expect(result.ok).toBe(true);
}, 60_000);

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const mapPath = (): string => join(cwd, config.store.dir, 'map.json');

describe('diff base anchored to the recorded commit', () => {
  it('selects nothing when nothing changed since the map was recorded', async () => {
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual([]);
  });

  it('sees a source change that was committed after the map was recorded', async () => {
    write('src/a.mjs', `${ADD}// changed after recording\n`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'change a']);

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('falls open to a full run when the recorded commit is missing from this checkout', async () => {
    const map = JSON.parse(readFileSync(mapPath(), 'utf8')) as { commit: string };
    map.commit = '0'.repeat(40);
    writeFileSync(mapPath(), JSON.stringify(map));

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/does not have/);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('falls open to a full run when the map records no commit at all', async () => {
    const map = JSON.parse(readFileSync(mapPath(), 'utf8')) as Record<string, unknown>;
    delete map.commit;
    writeFileSync(mapPath(), JSON.stringify(map));

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('honours an explicit --since over the recorded commit', async () => {
    const base = git(['rev-parse', 'HEAD']);
    write('src/a.mjs', `${ADD}// changed\n`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'change a']);

    const result = await selectAffected({ cwd, config, since: base });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });
});
