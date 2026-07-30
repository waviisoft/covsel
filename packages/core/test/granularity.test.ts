import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeStatus,
  type CoverageMap,
  GRANULARITIES,
  isGranularity,
  LocalStore,
  loadConfig,
  MAP_SCHEMA_VERSION,
  type Recorder,
  recordMap,
  resolveConfig,
  OBSERVES_EVERYTHING,
  selectAffected,
} from '../src/index.js';

/**
 * The granularities the map may name are the ones covsel records and selects at.
 *
 * The map is a versioned on-disk contract, so a value it admits is a promise
 * that something can write it and something can read it. A granularity no
 * recorder produces and no selector understands is a hole in that contract: the
 * map claims a meaning covsel cannot supply, and every reader is left to guess
 * one. The guess is what matters here, because half the ways to spell it — a
 * check for "block", say — degrade quietly to whole-file, and the other half —
 * "not file" — select by blocks the map never carried. So an unrecognized
 * granularity is refused at both ends: the config that asks for it fails, and
 * the stored map that names it is unusable, which is a full run.
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

/**
 * A map covering one source per test, written with whatever granularity the
 * caller names — including one covsel does not implement, which is why this
 * takes a `string` rather than a `Granularity`.
 */
function writeMap(granularity: string): void {
  const map = {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity,
    commit: git(['rev-parse', 'HEAD']),
    recordedAt: new Date().toISOString(),
    sentinelHashes: {},
    observed: ['**'],
    entries: [
      {
        test: { file: 'test/a.test.js' },
        files: [{ file: 'src/a.js', fileHash: 'sha256:a' }],
      },
      {
        test: { file: 'test/b.test.js' },
        files: [{ file: 'src/b.js', fileHash: 'sha256:b' }],
      },
    ],
  };
  mkdirSync(join(cwd, config.store.dir), { recursive: true });
  writeFileSync(mapPath(), JSON.stringify(map));
}

/** A recorder that yields fixed coverage, so recording needs no runner. */
function stubRecorder(blocks: boolean): Recorder {
  return {
    observes: OBSERVES_EVERYTHING,
    async record(testFile: string) {
      return [
        {
          test: { file: testFile },
          files: [{ file: 'src/a.js', fileHash: 'sha256:a' }],
          blocks: blocks ? [{ file: 'src/a.js', blockHash: 'sha256:block' }] : [],
        },
      ];
    },
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-granularity-'));
  write('src/a.js', 'exports.a = () => 1;\n');
  write('src/b.js', 'exports.b = () => 2;\n');
  write('test/a.test.js', "require('../src/a.js');\n");
  write('test/b.test.js', "require('../src/b.js');\n");
  write('package.json', '{\n  "name": "fixture",\n  "private": true\n}\n');
  write('.gitignore', '.covsel/\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'fixture']);
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('the granularities the schema admits', () => {
  it('are exactly the ones covsel records and selects at', () => {
    expect([...GRANULARITIES].sort()).toEqual(['block', 'file']);
  });

  it('do not include line, which block hashing exists to replace', () => {
    expect(isGranularity('line')).toBe(false);
    expect(isGranularity('statement')).toBe(false);
    expect(isGranularity(undefined)).toBe(false);
    expect(isGranularity(7)).toBe(false);
    expect(isGranularity('block')).toBe(true);
    expect(isGranularity('file')).toBe(true);
  });
});

describe('a recorded map', () => {
  it('names a granularity covsel implements when blocks were captured', async () => {
    const result = await recordMap({ cwd, config, recorder: stubRecorder(true) });
    expect(result.ok).toBe(true);
    expect(result.map!.granularity).toBe('block');
    expect(isGranularity(result.map!.granularity)).toBe(true);
  });

  it('names file when blocks were not captured', async () => {
    const result = await recordMap({ cwd, config, recorder: stubRecorder(false) });
    expect(result.ok).toBe(true);
    expect(result.map!.granularity).toBe('file');
  });
});

describe('a stored map naming a granularity covsel does not implement', () => {
  it('is not usable, so selection falls open to a full run', async () => {
    writeMap('line');
    write('src/a.js', 'exports.a = () => 99;\n');

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.tests).toEqual(['test/a.test.js', 'test/b.test.js']);
  });

  it('never selects fewer tests than the same map at whole-file granularity', async () => {
    write('src/a.js', 'exports.a = () => 99;\n');

    writeMap('file');
    const wholeFile = await selectAffected({ cwd, config });
    writeMap('line');
    const unknown = await selectAffected({ cwd, config });

    // The point of the guard: a map that means nothing must not out-narrow one
    // that means whole-file. Whole-file here selects only the test covering the
    // changed source, so a silent degradation to it would look like a working
    // selection.
    expect(wholeFile.tests).toEqual(['test/a.test.js']);
    for (const test of wholeFile.tests) expect(unknown.tests).toContain(test);
    expect(unknown.tests.length).toBeGreaterThanOrEqual(wholeFile.tests.length);
  });

  it('reads back from the store as no map at all', async () => {
    writeMap('line');
    expect(await new LocalStore({ cwd, dir: config.store.dir }).read()).toBeUndefined();
  });

  it('is reported by status as a full run rather than as select', async () => {
    writeMap('line');
    const status = await computeStatus({ cwd, config });
    expect(status.nextIsFullRun).toBe(true);
  });
});

describe('a map written before this change', () => {
  it('selects exactly as it did at whole-file granularity', async () => {
    writeMap('file');
    write('src/b.js', 'exports.b = () => 99;\n');

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/b.test.js']);
  });

  it('selects exactly as it did at block granularity', async () => {
    writeMap('block');
    write('src/b.js', 'exports.b = () => 99;\n');

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/b.test.js']);
  });
});

describe('a config asking for a granularity covsel does not implement', () => {
  it('fails naming the supported values', () => {
    expect(() => resolveConfig({ granularity: 'line' as never })).toThrow(/line/);
    expect(() => resolveConfig({ granularity: 'line' as never })).toThrow(/block/);
    expect(() => resolveConfig({ granularity: 'line' as never })).toThrow(/file/);
  });

  it('fails when any command loads the config file', async () => {
    write('covsel.json', `${JSON.stringify({ granularity: 'line' })}\n`);
    await expect(loadConfig(cwd)).rejects.toThrow(/granularity/);
  });

  it('does not fall back to a granularity the project did not ask for', () => {
    // Silently resolving to `file` would record and select at a granularity the
    // project never named, and silently resolving to `block` would ignore the
    // ask altogether. Neither is something the project could see happening.
    let resolved: unknown;
    try {
      resolved = resolveConfig({ granularity: 'line' as never });
    } catch {
      resolved = undefined;
    }
    expect(resolved).toBeUndefined();
  });

  it('accepts the granularities covsel does implement', () => {
    expect(resolveConfig({ granularity: 'block' }).granularity).toBe('block');
    expect(resolveConfig({ granularity: 'file' }).granularity).toBe('file');
    expect(resolveConfig().granularity).toBe('block');
  });
});

/** Compile-time half of the same contract: the map's type admits only these. */
describe('the Granularity type', () => {
  it('does not admit line', () => {
    const map: CoverageMap = {
      schemaVersion: MAP_SCHEMA_VERSION,
      // @ts-expect-error 'line' is not a granularity covsel implements
      granularity: 'line',
      recordedAt: '2026-01-01T00:00:00.000Z',
      sentinelHashes: {},
      observed: ['**'],
      entries: [],
    };
    expect(isGranularity(map.granularity)).toBe(false);
  });
});
