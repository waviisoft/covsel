import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeStatus,
  discoverTestFiles,
  ignoredTestFiles,
  MAP_SCHEMA_VERSION,
  recordedConfig,
  resolveConfig,
  selectAffected,
} from '../src/index.js';
import { commitAll, git, write } from './helpers/repo.js';

/**
 * `testIgnore` exists because covsel walks the tree while the runner it wraps
 * reads its own config, and the two can disagree. A test the runner excludes is
 * one covsel must not try to record: recording it fails for reasons that have
 * nothing to do with the test, and a failed recording writes no map at all, so
 * one such file stops the whole project selecting.
 *
 * It is also a claim that can skip tests if it is wrong, which is why the count
 * is reported rather than applied quietly.
 */

const temps: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-ignore-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project with two tests, one of which the runner will not run. */
function project(): { cwd: string; config: ReturnType<typeof resolveConfig> } {
  const cwd = tempRepo();
  write(cwd, 'src/math.ts', 'export const add = (a: number, b: number) => a + b;\n');
  write(cwd, 'test/unit.test.ts', 'export {};\n');
  write(cwd, 'test/browser.test.ts', 'export {};\n');
  const config = resolveConfig({
    testGlobs: ['test/**/*.test.ts'],
    sourceGlobs: ['src/**'],
    testIgnore: ['test/browser.test.ts'],
  });
  return { cwd, config };
}

/**
 * A project whose selection narrows: a committed tree and a map recorded at that
 * commit, so `selectAffected` reaches the rules that only run when there is a
 * map to narrow by. A full run is built straight from discovery and would pass
 * without executing any of them.
 */
function narrowing(extra: Record<string, unknown> = {}): {
  cwd: string;
  config: ReturnType<typeof resolveConfig>;
} {
  const cwd = tempRepo();
  write(cwd, 'src/math.ts', 'export const add = (a: number, b: number) => a + b;\n');
  write(cwd, 'test/unit.test.ts', 'export {};\n');
  write(cwd, 'test/browser.test.ts', 'export {};\n');
  commitAll(cwd);
  const commit = git(cwd, ['rev-parse', 'HEAD']);
  write(
    cwd,
    '.covsel/map.json',
    `${JSON.stringify({
      schemaVersion: MAP_SCHEMA_VERSION,
      granularity: 'file',
      recordedAt: new Date(Date.now() - 60_000).toISOString(),
      commit,
      sentinelHashes: {},
      observed: ['**'],
      entries: [
        {
          test: { file: 'test/unit.test.ts' },
          files: [{ file: 'src/math.ts', fileHash: 'sha256:math' }],
        },
      ],
    })}\n`,
  );
  const config = resolveConfig({
    testGlobs: ['test/**/*.test.ts'],
    sourceGlobs: ['src/**'],
    testIgnore: ['test/browser.test.ts'],
    granularity: 'file',
    ...extra,
  });
  return { cwd, config };
}

describe('a test the runner will not run', () => {
  it('is not discovered', () => {
    const { cwd, config } = project();
    expect(discoverTestFiles(cwd, config)).toEqual(['test/unit.test.ts']);
  });

  it('is still reported, so the exclusion is never silent', () => {
    const { cwd, config } = project();
    expect(ignoredTestFiles(cwd, config)).toEqual(['test/browser.test.ts']);
  });

  it('is never selected, even with no map to narrow by', async () => {
    // A full run is where every discovered test runs. An ignored one must not
    // be in that list either: covsel would be handing the runner a file it has
    // been told to skip.
    const { cwd, config } = project();
    commitAll(cwd);
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.tests).toEqual(['test/unit.test.ts']);
    expect(result.discovered).toBe(1);
  });

  it('is left out of alwaysRun too, since the runner still cannot run it', async () => {
    // Narrowing, not a full run: a full run is built straight from discovery, so
    // it would pass without the alwaysRun path ever executing. The map is what
    // makes selection reach that branch at all.
    const { cwd, config } = narrowing({ alwaysRun: ['test/browser.test.ts'] });
    write(cwd, 'src/math.ts', 'export const add = (a: number, b: number) => b + a;\n');
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).not.toContain('test/browser.test.ts');
  });

  it('is not selected by being edited itself', async () => {
    // The one rule that reaches a changed test file directly: a modified test
    // runs whatever the map says. It cannot here -- covsel would be handing the
    // runner the single file the project said it refuses, which fails the run
    // rather than protecting it.
    const { cwd, config } = narrowing();
    write(cwd, 'test/browser.test.ts', 'export const changed = true;\n');
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).not.toContain('test/browser.test.ts');
  });
});

describe('a bare filename', () => {
  it('takes nothing with it, rather than every file of that name', () => {
    // `makeMatcher` widens a slash-less glob to the basename anywhere in the
    // tree, which is safe wherever a match runs more tests. Here a match runs
    // fewer, so widening would delete a suite: someone writing this to mean one
    // file would silently lose both, and whatever only the other one covered
    // would be selected by nothing thereafter.
    //
    // Strict matching answers it in the safe direction. A bare name matches no
    // repo-relative path, so it ignores nothing and the project over-selects
    // until the entry is written out in full.
    const cwd = tempRepo();
    write(cwd, 'test/a/browser.test.ts', 'export {};\n');
    write(cwd, 'test/b/browser.test.ts', 'export {};\n');
    const config = resolveConfig({
      testGlobs: ['test/**/*.test.ts'],
      testIgnore: ['browser.test.ts'],
    });
    expect(discoverTestFiles(cwd, config)).toEqual([
      'test/a/browser.test.ts',
      'test/b/browser.test.ts',
    ]);
  });

  it('written out in full, removes exactly the one file', () => {
    const cwd = tempRepo();
    write(cwd, 'test/a/browser.test.ts', 'export {};\n');
    write(cwd, 'test/b/browser.test.ts', 'export {};\n');
    const config = resolveConfig({
      testGlobs: ['test/**/*.test.ts'],
      testIgnore: ['test/a/browser.test.ts'],
    });
    expect(discoverTestFiles(cwd, config)).toEqual(['test/b/browser.test.ts']);
  });
});

describe('status', () => {
  it('reports how many files the exclusion removed', async () => {
    const { cwd, config } = project();
    commitAll(cwd);
    const status = await computeStatus({ cwd, config });
    expect(status.discoveredTestCount).toBe(1);
    expect(status.ignoredTestCount).toBe(1);
  });

  it('says nothing about it when a project ignores nothing', async () => {
    const cwd = tempRepo();
    write(cwd, 'src/math.ts', 'export const add = (a: number, b: number) => a + b;\n');
    write(cwd, 'test/unit.test.ts', 'export {};\n');
    commitAll(cwd);
    const status = await computeStatus({
      cwd,
      config: resolveConfig({
        testGlobs: ['test/**/*.test.ts'],
        sourceGlobs: ['src/**'],
      }),
    });
    expect(status.ignoredTestCount).toBeUndefined();
  });
});

describe('the recorded configuration', () => {
  it('carries the exclusion, so changing it falls open rather than passing quietly', () => {
    // The list decides which tests exist as far as covsel is concerned. A map
    // recorded under one list cannot vouch for selection under another, and
    // being part of the recorded config is what makes that a full run instead
    // of a silently narrower suite.
    const before = recordedConfig(
      resolveConfig({ testGlobs: ['test/**/*.test.ts'], testIgnore: [] }),
    );
    const after = recordedConfig(
      resolveConfig({
        testGlobs: ['test/**/*.test.ts'],
        testIgnore: ['test/browser.test.ts'],
      }),
    );
    expect(before).toHaveProperty('testIgnore');
    expect(before.testIgnore).not.toEqual(after.testIgnore);
  });
});

describe('a project that ignores nothing', () => {
  it('discovers exactly what it did before the option existed', () => {
    const cwd = tempRepo();
    write(cwd, 'test/a.test.ts', 'export {};\n');
    write(cwd, 'test/b.test.ts', 'export {};\n');
    const config = resolveConfig({ testGlobs: ['test/**/*.test.ts'] });
    expect(discoverTestFiles(cwd, config)).toEqual(['test/a.test.ts', 'test/b.test.ts']);
    expect(ignoredTestFiles(cwd, config)).toEqual([]);
  });
});
