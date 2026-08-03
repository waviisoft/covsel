import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeStatus,
  type CoverageMap,
  isUsableMap,
  LocalStore,
  MAP_SCHEMA_VERSION,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * The map that is sitting right there and cannot be used.
 *
 * `LocalStore.read()` answers the only question selection may ask — can this map
 * be believed — and collapses missing, unparseable, and wrong-schema into one
 * `undefined`. That is right for selection and wrong for `status`, which exists
 * to answer "why is covsel about to do this": it reported the path of a file it
 * had just read and then said the file did not exist.
 *
 * A schema bump makes this the first thing every user sees on upgrade, so the
 * distinction is drawn in a diagnostic read beside the selection one. The last
 * describe here is the guard that matters most: the two reads may never disagree
 * about usability, whatever either of them says about why.
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

/** Put `contents` where the store looks for its map, verbatim. */
function writeMapFile(contents: string): void {
  mkdirSync(join(cwd, config.store.dir), { recursive: true });
  writeFileSync(join(cwd, config.store.dir, 'map.json'), contents);
}

/** A map covsel can use, recorded against the current commit. */
function usableMap(): CoverageMap {
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity: 'file',
    commit: git(['rev-parse', 'HEAD']),
    recordedAt: new Date().toISOString(),
    sentinelHashes: {},
    observed: ['**'],
    entries: [{ test: { file: 'test/math.test.js' }, files: [] }],
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-unusable-'));
  write('src/math.js', 'exports.add = (a, b) => a + b;\n');
  // Matches the default test globs, so discovery finding nothing never stands in
  // for the map's own verdict in what status reports.
  write('test/math.test.js', "require('node:test');\n");
  write('package.json', '{\n  "name": "repro",\n  "private": true\n}\n');
  write('.gitignore', '.covsel/\n');
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('a map recorded under an older schema', () => {
  beforeEach(() => {
    writeMapFile(
      JSON.stringify({ ...usableMap(), schemaVersion: MAP_SCHEMA_VERSION - 1 }),
    );
  });

  it('reports the map as present and unusable, not as absent', async () => {
    const status = await computeStatus({ cwd, config });
    expect(status.mapState).toBe('unusable');
  });

  it('names the schema it found and the one covsel reads, and says to re-record', async () => {
    const status = await computeStatus({ cwd, config });
    expect(status.unusableReason).toContain(`v${MAP_SCHEMA_VERSION - 1}`);
    expect(status.unusableReason).toContain(`v${MAP_SCHEMA_VERSION}`);
    expect(status.unusableReason).toMatch(/re-record/);
  });

  it('gives a reason for the full run instead of leaving the field empty', async () => {
    const status = await computeStatus({ cwd, config });
    expect(status.nextIsFullRun).toBe(true);
    expect(status.nextFullRunReason).toMatch(/stale or has an incompatible schema/);
  });

  it('still falls open to a full run, exactly as before', async () => {
    // The diagnostic read is a report, not a second opinion: a map covsel cannot
    // use runs everything however well status describes it.
    write('src/math.js', 'exports.add = (a, b) => a + b; // changed\n');
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
  });
});

describe('a map file that is not there at all', () => {
  it('reports it as absent, and says that is why the next run is full', async () => {
    const status = await computeStatus({ cwd, config });
    expect(status.mapState).toBe('absent');
    expect(status.unusableReason).toBeUndefined();
    expect(status.nextIsFullRun).toBe(true);
    expect(status.nextFullRunReason).toMatch(/no usable map recorded/);
  });
});

describe('a map file that is not JSON', () => {
  it('reports it as present and unusable, and says the file could not be parsed', async () => {
    writeMapFile('{ "schemaVersion": ');
    const status = await computeStatus({ cwd, config });
    expect(status.mapState).toBe('unusable');
    expect(status.unusableReason).toMatch(/JSON/);
  });
});

describe('a map covsel can use', () => {
  it('is reported as usable, with nothing to explain away', async () => {
    writeMapFile(JSON.stringify(usableMap()));
    const status = await computeStatus({ cwd, config });
    expect(status.mapState).toBe('usable');
    expect(status.unusableReason).toBeUndefined();
    expect(status.entryCount).toBe(1);
  });
});

describe('the diagnostic read and the selection read cannot disagree', () => {
  /**
   * Every shape `isUsableMap` rejects, and one it does not. The reason strings
   * are free to change; what may never change is that a map the diagnostic read
   * calls usable is one selection would also accept, and the other way round.
   * This is the drift the fix has to make impossible, not merely unlikely.
   */
  const shapes: [name: string, contents: () => string][] = [
    ['an older schema', () => JSON.stringify({ ...usableMap(), schemaVersion: 1 })],
    ['no schema version', () => JSON.stringify({ ...usableMap(), schemaVersion: null })],
    ['no entries', () => JSON.stringify({ ...usableMap(), entries: undefined })],
    ['entries that are not a list', () => JSON.stringify({ ...usableMap(), entries: 7 })],
    [
      'a granularity covsel does not record at',
      () => JSON.stringify({ ...usableMap(), granularity: 'line' }),
    ],
    ['no observed scope', () => JSON.stringify({ ...usableMap(), observed: undefined })],
    [
      'an observed scope that is not globs',
      () => JSON.stringify({ ...usableMap(), observed: [1, 2] }),
    ],
    ['a JSON array', () => '[]'],
    ['JSON null', () => 'null'],
    ['nothing parseable', () => 'not json at all'],
    ['a map covsel can use', () => JSON.stringify(usableMap())],
  ];

  it.each(shapes)('agree about %s', async (_name, contents) => {
    const text = contents();
    writeMapFile(text);
    const store = new LocalStore({ cwd, dir: config.store.dir });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const usable = isUsableMap(parsed);

    expect(store.inspect().state === 'usable').toBe(usable);
    expect((await store.read()) !== undefined).toBe(usable);
    expect(
      await computeStatus({ cwd, config }).then((s) => s.mapState === 'usable'),
    ).toBe(usable);
  });

  it('has a reason for every map it calls unusable', async () => {
    for (const [, contents] of shapes) {
      writeMapFile(contents());
      const store = new LocalStore({ cwd, dir: config.store.dir });
      const stored = store.inspect();
      if (stored.state === 'unusable') expect(stored.reason).not.toBe('');
    }
  });
});
