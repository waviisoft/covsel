import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { compareSuites, discoverTestFiles, resolveConfig } from '@covsel/core';

import { vitestAdapter } from '../src/index.js';

/**
 * `listTests` exists to be compared against covsel's own discovery, so what is
 * checked here is that the comparison would mean something: that the answer
 * comes from the runner's configuration rather than from covsel's, that it is
 * expressed in the paths covsel discovers in, and that a command this adapter
 * cannot turn into a listing says so instead of returning a set that reads as
 * agreement.
 */

const vitestBin = fileURLToPath(
  new URL('../../../examples/vitest-basic/node_modules/.bin/vitest', import.meta.url),
);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A project whose vitest config collects `test/` and excludes `test/browser/`. */
function project(vitestConfig: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-vitest-list-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'test', 'browser'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","private":true}\n');
  writeFileSync(join(dir, 'vitest.config.js'), vitestConfig);
  const trivial = "import { test } from 'vitest';\ntest('t', () => {});\n";
  writeFileSync(join(dir, 'test', 'a.test.js'), trivial);
  writeFileSync(join(dir, 'test', 'b.test.js'), trivial);
  writeFileSync(join(dir, 'test', 'browser', 'c.test.js'), trivial);
  return dir;
}

const COLLECTS_EVERYTHING = `export default { test: { include: ['test/**/*.test.js'] } };\n`;
const EXCLUDES_THE_BROWSER_DIR = `export default { test: { include: ['test/**/*.test.js'], exclude: ['test/browser/**'] } };\n`;

const config = resolveConfig({ testGlobs: ['test/**/*.test.js'] });

describe('asking vitest what it collects', () => {
  it('answers in the repo-relative paths covsel discovers in', async () => {
    const cwd = project(COLLECTS_EVERYTHING);
    const listed = await vitestAdapter.listTests!({
      command: [vitestBin, 'run'],
      cwd,
      config,
    });
    expect([...listed].sort()).toEqual([
      'test/a.test.js',
      'test/b.test.js',
      'test/browser/c.test.js',
    ]);
  }, 120_000);

  it('leaves out what the runner excludes, which covsel has no way to know', async () => {
    // The outage this is for: a browser test matched covsel's testGlobs and sat
    // in the runner's exclude list. covsel drove it in a job with no browser,
    // recording died, and no map was written at all. Nothing compared the two
    // lists, because nothing could ask the runner for its one.
    const cwd = project(EXCLUDES_THE_BROWSER_DIR);
    const listed = await vitestAdapter.listTests!({
      command: [vitestBin, 'run'],
      cwd,
      config,
    });
    expect([...listed].sort()).toEqual(['test/a.test.js', 'test/b.test.js']);
  }, 120_000);

  it('is what turns that exclusion into drift covsel can report', async () => {
    // End to end over the real pair, since the whole point is the comparison and
    // not either list on its own.
    const cwd = project(EXCLUDES_THE_BROWSER_DIR);
    const listed = await vitestAdapter.listTests!({
      command: [vitestBin, 'run'],
      cwd,
      config,
    });
    const drift = compareSuites(discoverTestFiles(cwd, config), listed);
    expect(drift.unrecordable).toEqual(['test/browser/c.test.js']);
    expect(drift.unselectable).toEqual([]);
  }, 120_000);

  it('finds no drift once testIgnore subtracts the same file', async () => {
    // And the guard has to go quiet when the project fixes it, or it is noise
    // rather than a signal.
    const cwd = project(EXCLUDES_THE_BROWSER_DIR);
    const fixed = resolveConfig({
      testGlobs: ['test/**/*.test.js'],
      testIgnore: ['test/browser/c.test.js'],
    });
    const listed = await vitestAdapter.listTests!({
      command: [vitestBin, 'run'],
      cwd,
      config: fixed,
    });
    const drift = compareSuites(discoverTestFiles(cwd, fixed), listed);
    expect(drift.unrecordable).toEqual([]);
    expect(drift.unselectable).toEqual([]);
  }, 120_000);
});

describe('a command this adapter cannot turn into a listing', () => {
  it('is refused rather than answered with a set that reads as agreement', async () => {
    // A wrong-but-parseable answer is worse than no answer: an empty or partial
    // list compares as "covsel discovers files the runner does not", which sends
    // someone to edit testGlobs over a question the runner was never asked.
    const cwd = project(COLLECTS_EVERYTHING);
    await expect(
      vitestAdapter.listTests!({ command: ['pnpm', 'test'], cwd, config }),
    ).rejects.toThrow(/could not ask vitest/i);
  }, 120_000);

  it('is refused when it succeeds but prints no JSON at all', async () => {
    // Reached only by a command that exits 0, which the failure above never
    // does -- so without this the shape check is never exercised and could be
    // deleted with every test still green.
    const cwd = project(COLLECTS_EVERYTHING);
    await expect(
      vitestAdapter.listTests!({
        command: ['node', '-e', 'console.log("ready")'],
        cwd,
        config,
      }),
    ).rejects.toThrow(/printed no JSON/);
  }, 120_000);

  it('is refused when it prints JSON that is not a listing', async () => {
    // vitest's own `--json` *run* report is an object, not this array, and a
    // wrapper script can produce one on a command that looked listable. Reading
    // it as "no test files" would report the entire suite as drift.
    const cwd = project(COLLECTS_EVERYTHING);
    await expect(
      vitestAdapter.listTests!({
        command: ['node', '-e', 'console.log(JSON.stringify({testResults: []}))'],
        cwd,
        config,
      }),
    ).rejects.toThrow(/not a test file listing/);
  }, 120_000);

  it('is refused for an empty command rather than spawning a shell', async () => {
    const cwd = project(COLLECTS_EVERYTHING);
    await expect(vitestAdapter.listTests!({ command: [], cwd, config })).rejects.toThrow(
      /empty command/,
    );
  });
});
