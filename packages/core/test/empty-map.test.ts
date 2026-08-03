import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeStatus,
  type CoverageMap,
  createGenericRecorder,
  MAP_SCHEMA_VERSION,
  recordMap,
  resolveConfig,
  runAffected,
  selectAffected,
} from '../src/index.js';

/**
 * The degenerate map: valid, trusted, and empty.
 *
 * Every other fail-open guard asks whether the map can be believed. This one is
 * about a map with nothing in it to believe — written by a recording that
 * discovered no test files, because the project names its tests `test/*.js` and
 * the default globs look for `*.test.js`. Nothing downstream treated it as
 * suspicious: `affected` printed nothing, and `covsel run` executed zero tests
 * and exited 0, which is a green CI job that ran no tests at all.
 *
 * The fixture is express-shaped on purpose: `lib/` plus `test/`, which is the
 * layout the default globs miss.
 */

const config = resolveConfig();

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

const mapPath = (): string => join(cwd, config.store.dir, 'map.json');

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-empty-'));
  write('lib/math.js', 'exports.add = (a, b) => a + b;\n');
  // Named the way express and a lot of Mocha and node:test projects name tests,
  // which the default `**/*.{test,spec}.*` globs do not match.
  write(
    'test/math.js',
    "const { test } = require('node:test');\nconst assert = require('node:assert');\n" +
      "const { add } = require('../lib/math.js');\n" +
      "test('add', () => assert.strictEqual(add(1, 2), 3));\n",
  );
  write('package.json', '{\n  "name": "repro",\n  "private": true\n}\n');
  write('.gitignore', '.covsel/\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('recording a project whose tests the globs do not match', () => {
  it('fails rather than writing a map of nothing', async () => {
    const result = await recordMap({
      cwd,
      config,
      recorder: createGenericRecorder({ command: ['node', '--test'], cwd, config }),
    });
    expect(result.ok).toBe(false);
    expect(result.recorded).toBe(0);
    expect(() => readFileSync(mapPath(), 'utf8')).toThrow();
  }, 60_000);

  it('names the globs and the directory it searched', async () => {
    const result = await recordMap({
      cwd,
      config,
      recorder: createGenericRecorder({ command: ['node', '--test'], cwd, config }),
    });
    expect(result.error).toContain('**/*.{test,spec}.?(c|m)[jt]s?(x)');
    expect(result.error).toContain(cwd);
    expect(result.error).toMatch(/testGlobs/);
  }, 60_000);

  it('reports no per-file failures, because no file failed', async () => {
    const result = await recordMap({
      cwd,
      config,
      recorder: createGenericRecorder({ command: ['node', '--test'], cwd, config }),
    });
    expect(result.failures).toEqual([]);
  }, 60_000);

  it('records normally once the globs match the project', async () => {
    const matching = resolveConfig({ testGlobs: ['test/**/*.js'] });
    const result = await recordMap({
      cwd,
      config: matching,
      recorder: createGenericRecorder({
        command: ['node', '--test'],
        cwd,
        config: matching,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.recorded).toBe(1);
  }, 60_000);
});

describe('selecting when discovery finds no test files', () => {
  it('falls open to a full run instead of selecting nothing', async () => {
    write('lib/math.js', 'exports.add = (a, b) => a + b; // changed\n');
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/no test files matched/);
  });

  it('says so through status rather than reporting the next run as a selection', async () => {
    const status = await computeStatus({ cwd, config });
    expect(status.discoveredTestCount).toBe(0);
    expect(status.nextIsFullRun).toBe(true);
    expect(status.nextFullRunReason).toMatch(/no test files matched/);
  });

  it('hands the runner its own command, so the runner finds what the globs missed', async () => {
    // The whole point of the fix: `covsel run` used to execute nothing and exit
    // 0. A full run passes the command through unfiltered, so `node --test`
    // discovers `test/math.js` by its own rules and actually runs it.
    const script = join(cwd, 'ran.txt');
    const code = await runAffected({
      cwd,
      config,
      adapter: {
        name: 'stub',
        formatSelection: (tests) => tests.map((t) => t.file),
        createRecorder: () => {
          throw new Error('not used');
        },
      },
      // Writes its own argv, so the test can assert the command was passed
      // through with no file arguments appended.
      command: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(script)}, JSON.stringify(process.argv.slice(1)))`,
      ],
    });

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(script, 'utf8'))).toEqual([]);
  }, 60_000);
});

describe('a map that exists but holds no entries', () => {
  /** Write a structurally valid map with no entries, as a bad merge would. */
  function writeEmptyMap(): void {
    const map: CoverageMap = {
      schemaVersion: MAP_SCHEMA_VERSION,
      granularity: 'file',
      commit: git(['rev-parse', 'HEAD']),
      recordedAt: new Date().toISOString(),
      sentinelHashes: {},
      observed: ['**'],
      entries: [],
    };
    mkdirSync(join(cwd, config.store.dir), { recursive: true });
    writeFileSync(mapPath(), JSON.stringify(map));
  }

  const matching = resolveConfig({ testGlobs: ['test/**/*.js'] });

  it('forces a full run, and says the map measured nothing', async () => {
    writeEmptyMap();
    write('lib/math.js', 'exports.add = (a, b) => a + b; // changed\n');

    const result = await selectAffected({ cwd, config: matching });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/no entries/);
    expect(result.tests).toEqual(['test/math.js']);
  });

  it('forces a full run even when nothing changed at all', async () => {
    // The map cannot vouch for a clean tree either: it never measured one.
    writeEmptyMap();
    const result = await selectAffected({ cwd, config: matching });
    expect(result.fullRun).toBe(true);
    expect(result.tests).toEqual(['test/math.js']);
  });

  it('is reported by status as a full run rather than as select', async () => {
    writeEmptyMap();
    const status = await computeStatus({ cwd, config: matching });
    expect(status.mapState).toBe('usable');
    expect(status.entryCount).toBe(0);
    expect(status.nextIsFullRun).toBe(true);
    expect(status.nextFullRunReason).toMatch(/no entries/);
  });
});
