import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CoverageMap,
  createGenericRecorder,
  recordMap,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * A map is trusted for the commit it names, exactly. Recording from an edited
 * tree describes a state no commit names — so stamping HEAD on it produces a map
 * that passes every guard covsel has: the commit exists, the tree matches it once
 * the edits are reverted, and the changed file is inside the observed scope. The
 * coverage the edited tree never executed is simply absent, and selection skips
 * the test that needed it.
 *
 * These tests hold the line that a map covsel cannot attribute to a commit does
 * not claim one.
 */

const config = resolveConfig();
const SHARED = 'export const tag = (s) => `[t] ${s}`;\n';
const A_USES_SHARED =
  "import { tag } from './shared.mjs';\nexport const alpha = (x) => tag(`a:${x}`);\n";
const A_STANDS_ALONE = 'export const alpha = (x) => `[t] a:${x}`;\n';

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

async function record(): ReturnType<typeof recordMap> {
  return recordMap({
    cwd,
    config,
    recorder: createGenericRecorder({ command: ['node', '--test'], cwd, config }),
  });
}

const readMap = (): CoverageMap =>
  JSON.parse(
    readFileSync(join(cwd, config.store.dir, 'map.json'), 'utf8'),
  ) as CoverageMap;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-dirty-'));
  write('src/shared.mjs', SHARED);
  write('src/a.mjs', A_USES_SHARED);
  write(
    'test/a.test.mjs',
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n" +
      "import { alpha } from '../src/a.mjs';\n" +
      "test('alpha', () => assert.equal(alpha(1), '[t] a:1'));\n",
  );
  write('package.json', '{\n  "name": "f",\n  "private": true,\n  "type": "module"\n}\n');
  write('.gitignore', '.covsel/\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('a map recorded from a dirty tree claims no commit', () => {
  it('records no commit when a tracked file is edited', async () => {
    write('src/a.mjs', A_STANDS_ALONE);
    expect((await record()).ok).toBe(true);
    expect(readMap().commit).toBeUndefined();
  }, 60_000);

  it('records no commit when an untracked file is present', async () => {
    // Untracked files are part of the tree the tests just ran against, and a
    // later checkout of HEAD does not have them.
    write('src/extra.mjs', 'export const extra = () => 1;\n');
    expect((await record()).ok).toBe(true);
    expect(readMap().commit).toBeUndefined();
  }, 60_000);

  it('records no commit when a change is staged but not committed', async () => {
    write('src/a.mjs', A_STANDS_ALONE);
    git(['add', 'src/a.mjs']);
    expect((await record()).ok).toBe(true);
    expect(readMap().commit).toBeUndefined();
  }, 60_000);

  it('still records the commit when the tree is clean', async () => {
    expect((await record()).ok).toBe(true);
    expect(readMap().commit).toBe(git(['rev-parse', 'HEAD']));
  }, 60_000);

  it('reports the map as unanchored, so the consequence is visible at record time', async () => {
    write('src/a.mjs', A_STANDS_ALONE);
    const result = await record();
    expect(result.unanchored).toBe(true);
  }, 60_000);

  it('does not call a clean recording unanchored', async () => {
    expect((await record()).unanchored).toBeUndefined();
  }, 60_000);
});

describe('the fail-closed case the stamp caused', () => {
  it('runs the test a reverted-then-changed dependency affects', async () => {
    // Verbatim from the bug report. Record from a tree where a.mjs no longer
    // imports shared.mjs, revert, then change shared.mjs — which HEAD's a.mjs
    // does import. The map never saw that import, so selecting on it skips a
    // test that genuinely fails.
    write('src/a.mjs', A_STANDS_ALONE);
    expect((await record()).ok).toBe(true);
    const map = readMap();
    expect(map.entries[0]?.files.map((f) => f.file)).not.toContain('src/shared.mjs');

    git(['checkout', '--', 'src/a.mjs']);
    write('src/shared.mjs', 'export const tag = (s) => `[CHANGED] ${s}`;\n');

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/records no commit/);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  }, 60_000);

  it('reports the reason through status rather than looking healthy', async () => {
    write('src/a.mjs', A_STANDS_ALONE);
    expect((await record()).ok).toBe(true);
    git(['checkout', '--', 'src/a.mjs']);

    const { computeStatus } = await import('../src/index.js');
    const status = await computeStatus({ cwd, config });
    expect(status.nextIsFullRun).toBe(true);
    expect(status.nextFullRunReason).toMatch(/records no commit/);
  }, 60_000);
});
