import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ArchivedMap,
  archiveDirFor,
  chooseArchivedMap,
  type CommitChecks,
  type CoverageMap,
  createGenericRecorder,
  fetchMap,
  listArchive,
  MAP_SCHEMA_VERSION,
  publishMap,
  recordMap,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * The archive exists so a CI job can be handed a map it can actually measure
 * change from. Every test here is about that choice: which map, and what happens
 * when none of them will do. Nothing in this file may make "no usable map" read
 * as "no tests to run".
 */

const config = resolveConfig();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'covsel-archive-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function mapAt(commit: string | undefined, recordedAt: string): CoverageMap {
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity: 'file',
    ...(commit !== undefined ? { commit } : {}),
    recordedAt,
    sentinelHashes: {},
    observed: ['**'],
    entries: [{ test: { file: 'test/a.test.mjs' }, files: [] }],
  };
}

const sha = (n: number): string => String(n).padStart(40, '0');

/** Fixed answers about a checkout, so choosing can be tested without a repo. */
function checks(init: { has?: string[]; ancestors?: string[] }): CommitChecks {
  const has = new Set(init.has ?? init.ancestors ?? []);
  for (const a of init.ancestors ?? []) has.add(a);
  const ancestors = new Set(init.ancestors ?? []);
  return { has: (c) => has.has(c), isAncestor: (c) => ancestors.has(c) };
}

const archived = (commit: string, recordedAt: string): ArchivedMap => ({
  commit,
  recordedAt,
  file: join(dir, `${commit}.json`),
});

describe('a recorded map is published under the commit it records', () => {
  it('writes the map addressed by its commit', () => {
    const result = publishMap({ dir, map: mapAt(sha(1), '2026-07-01T00:00:00.000Z') });
    expect(result.ok).toBe(true);
    expect(readdirSync(dir)).toEqual([`${sha(1)}.json`]);
    expect(listArchive(dir).map((m) => m.commit)).toEqual([sha(1)]);
  });

  it('replaces rather than duplicates when the same commit is published again', () => {
    publishMap({ dir, map: mapAt(sha(1), '2026-07-01T00:00:00.000Z') });
    publishMap({ dir, map: mapAt(sha(1), '2026-07-02T00:00:00.000Z') });
    expect(readdirSync(dir)).toEqual([`${sha(1)}.json`]);
    expect(listArchive(dir)[0]?.recordedAt).toBe('2026-07-02T00:00:00.000Z');
  });
});

describe('a map that names no commit cannot be published', () => {
  it('fails and leaves the archive untouched', () => {
    const result = publishMap({ dir, map: mapAt(undefined, '2026-07-01T00:00:00.000Z') });
    expect(result.ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('says the map cannot be measured from', () => {
    const result = publishMap({ dir, map: mapAt(undefined, '2026-07-01T00:00:00.000Z') });
    expect(result.ok === false && result.reason).toMatch(/records no commit/);
  });

  it('refuses a commit that is not a hash, rather than writing where it says', () => {
    const result = publishMap({
      dir,
      map: mapAt('../../escaped', '2026-07-01T00:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('a store keeps only the newest maps', () => {
  it('prunes the oldest beyond the limit and reports them', () => {
    publishMap({ dir, map: mapAt(sha(1), '2026-07-01T00:00:00.000Z'), keep: 2 });
    publishMap({ dir, map: mapAt(sha(2), '2026-07-02T00:00:00.000Z'), keep: 2 });
    const result = publishMap({
      dir,
      map: mapAt(sha(3), '2026-07-03T00:00:00.000Z'),
      keep: 2,
    });
    expect(result.ok === true && result.pruned).toEqual([sha(1)]);
    expect(listArchive(dir).map((m) => m.commit)).toEqual([sha(3), sha(2)]);
  });

  it('keeps the map just published even at a limit of one', () => {
    publishMap({ dir, map: mapAt(sha(1), '2026-07-01T00:00:00.000Z'), keep: 1 });
    publishMap({ dir, map: mapAt(sha(2), '2026-07-02T00:00:00.000Z'), keep: 1 });
    expect(listArchive(dir).map((m) => m.commit)).toEqual([sha(2)]);
  });
});

describe('listing an archive', () => {
  it('orders maps newest first', () => {
    publishMap({ dir, map: mapAt(sha(2), '2026-07-02T00:00:00.000Z') });
    publishMap({ dir, map: mapAt(sha(1), '2026-07-03T00:00:00.000Z') });
    expect(listArchive(dir).map((m) => m.commit)).toEqual([sha(1), sha(2)]);
  });

  it('skips files that are not usable maps rather than failing', () => {
    publishMap({ dir, map: mapAt(sha(1), '2026-07-01T00:00:00.000Z') });
    writeFileSync(join(dir, `${sha(2)}.json`), 'not json');
    writeFileSync(join(dir, `${sha(3)}.json`), '{"schemaVersion":0,"entries":[]}');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    expect(listArchive(dir).map((m) => m.commit)).toEqual([sha(1)]);
  });

  it('skips a map whose own commit disagrees with its file name', () => {
    // Filed under one commit, describing another: ancestry would be tested
    // against the name and the diff taken from the content.
    writeFileSync(
      join(dir, `${sha(1)}.json`),
      JSON.stringify(mapAt(sha(2), '2026-07-01T00:00:00.000Z')),
    );
    expect(listArchive(dir)).toEqual([]);
  });

  it('is empty for a directory that does not exist', () => {
    expect(listArchive(join(dir, 'nope'))).toEqual([]);
  });
});

describe('the newest usable map wins', () => {
  it('chooses the most recently recorded ancestor', () => {
    const candidates = [
      archived(sha(3), '2026-07-03T00:00:00.000Z'),
      archived(sha(2), '2026-07-02T00:00:00.000Z'),
    ];
    const choice = chooseArchivedMap(candidates, checks({ ancestors: [sha(2), sha(3)] }));
    expect(choice.kind === 'chosen' && choice.map.commit).toBe(sha(3));
    expect(choice.kind === 'chosen' && choice.how).toBe('ancestor');
  });
});

describe('an ancestor is preferred over a newer map this checkout cannot use', () => {
  it('passes over a newer commit that is absent from the checkout', () => {
    const choice = chooseArchivedMap(
      [
        archived(sha(9), '2026-07-09T00:00:00.000Z'),
        archived(sha(2), '2026-07-02T00:00:00.000Z'),
      ],
      checks({ ancestors: [sha(2)] }),
    );
    expect(choice.kind === 'chosen' && choice.map.commit).toBe(sha(2));
    expect(choice.skipped).toEqual([
      { commit: sha(9), reason: 'not in this checkout (fetch more history?)' },
    ]);
  });

  it('passes over a newer diverged commit in favour of an ancestor', () => {
    // The diverged map would select soundly but diffs two trees against each
    // other, so it over-selects. The ancestor is the tight answer.
    const choice = chooseArchivedMap(
      [
        archived(sha(9), '2026-07-09T00:00:00.000Z'),
        archived(sha(2), '2026-07-02T00:00:00.000Z'),
      ],
      checks({ has: [sha(9)], ancestors: [sha(2)] }),
    );
    expect(choice.kind === 'chosen' && choice.map.commit).toBe(sha(2));
    expect(choice.kind === 'chosen' && choice.how).toBe('ancestor');
  });

  it('falls back to a diverged commit the checkout has when no ancestor is archived', () => {
    // Sound but wider than an ancestor would be, and strictly better than the
    // full run that choosing nothing would cause.
    const choice = chooseArchivedMap(
      [
        archived(sha(9), '2026-07-09T00:00:00.000Z'),
        archived(sha(2), '2026-07-02T00:00:00.000Z'),
      ],
      checks({ has: [sha(9), sha(2)] }),
    );
    expect(choice.kind === 'chosen' && choice.map.commit).toBe(sha(9));
    expect(choice.kind === 'chosen' && choice.how).toBe('present');
  });
});

describe('an unusable archive chooses nothing', () => {
  it('reports every candidate and why it could not be used', () => {
    const choice = chooseArchivedMap(
      [
        archived(sha(9), '2026-07-09T00:00:00.000Z'),
        archived(sha(8), '2026-07-08T00:00:00.000Z'),
      ],
      checks({}),
    );
    expect(choice.kind).toBe('none');
    expect(choice.skipped.map((s) => s.commit)).toEqual([sha(9), sha(8)]);
  });
});

describe('fetching installs the chosen map', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'covsel-fetch-'));
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('writes it where every other command reads the map', async () => {
    publishMap({ dir, map: mapAt(sha(1), '2026-07-01T00:00:00.000Z') });
    const result = await fetchMap({
      cwd,
      dir,
      storeDir: config.store.dir,
      checks: checks({ ancestors: [sha(1)] }),
    });
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.commit).toBe(sha(1));
    const installed = JSON.parse(
      readFileSync(join(cwd, config.store.dir, 'map.json'), 'utf8'),
    ) as CoverageMap;
    expect(installed.commit).toBe(sha(1));
  });

  it('installs nothing and says so when the archive holds nothing usable', async () => {
    publishMap({ dir, map: mapAt(sha(1), '2026-07-01T00:00:00.000Z') });
    const result = await fetchMap({
      cwd,
      dir,
      storeDir: config.store.dir,
      checks: checks({}),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/measure change from/);
  });

  it('says the archive is empty differently from unusable', async () => {
    const result = await fetchMap({
      cwd,
      dir: join(dir, 'nope'),
      storeDir: config.store.dir,
      checks: checks({}),
    });
    expect(result.ok === false && result.reason).toMatch(/nothing has been published/);
  });

  it('refuses to replace a local map recorded more recently', async () => {
    publishMap({ dir, map: mapAt(sha(1), '2026-07-01T00:00:00.000Z') });
    mkdirSync(join(cwd, config.store.dir), { recursive: true });
    writeFileSync(
      join(cwd, config.store.dir, 'map.json'),
      JSON.stringify(mapAt(sha(2), '2026-07-05T00:00:00.000Z')),
    );
    const result = await fetchMap({
      cwd,
      dir,
      storeDir: config.store.dir,
      checks: checks({ ancestors: [sha(1)] }),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/--force/);
  });

  it('replaces it with --force', async () => {
    publishMap({ dir, map: mapAt(sha(1), '2026-07-01T00:00:00.000Z') });
    mkdirSync(join(cwd, config.store.dir), { recursive: true });
    writeFileSync(
      join(cwd, config.store.dir, 'map.json'),
      JSON.stringify(mapAt(sha(2), '2026-07-05T00:00:00.000Z')),
    );
    const result = await fetchMap({
      cwd,
      dir,
      storeDir: config.store.dir,
      force: true,
      checks: checks({ ancestors: [sha(1)] }),
    });
    expect(result.ok).toBe(true);
  });
});

describe('the archive directory', () => {
  it('sits inside the store directory by default', () => {
    expect(archiveDirFor('/repo', config)).toBe('/repo/.covsel/archive');
  });

  it('honours an absolute setting, for a shared volume', () => {
    const shared = resolveConfig({ store: { archiveDir: '/mnt/covsel' } });
    expect(archiveDirFor('/repo', shared)).toBe('/mnt/covsel');
  });
});

describe('a fetched map selects exactly as a locally recorded one', () => {
  let cwd: string;
  const ADD = 'export function add(a, b) {\n  return a + b;\n}\n';

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

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'covsel-ci-'));
    write('src/a.mjs', ADD);
    write('src/b.mjs', 'export const untested = () => 1;\n');
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
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('selects the affected test after publish, discard, and fetch', async () => {
    // Record on the default branch and publish, as a main-branch CI job would.
    const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
    expect((await recordMap({ cwd, config, recorder })).ok).toBe(true);
    const local = JSON.parse(
      readFileSync(join(cwd, config.store.dir, 'map.json'), 'utf8'),
    ) as CoverageMap;
    const published = publishMap({ dir: archiveDirFor(cwd, config), map: local });
    expect(published.ok).toBe(true);

    // A fresh checkout of a later commit: no local map, and a change to a source
    // the recorded test covers.
    rmSync(join(cwd, config.store.dir, 'map.json'));
    write('src/a.mjs', `${ADD}// changed on the branch\n`);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'change a']);

    const fetched = await fetchMap({
      cwd,
      dir: archiveDirFor(cwd, config),
      storeDir: config.store.dir,
    });
    expect(fetched.ok).toBe(true);
    expect(fetched.ok === true && fetched.how).toBe('ancestor');

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  }, 60_000);

  it('falls open to a full run when nothing has been published', async () => {
    const fetched = await fetchMap({
      cwd,
      dir: archiveDirFor(cwd, config),
      storeDir: config.store.dir,
    });
    expect(fetched.ok).toBe(false);

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('does not select a test whose sources the diff leaves alone', async () => {
    const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
    expect((await recordMap({ cwd, config, recorder })).ok).toBe(true);
    const local = JSON.parse(
      readFileSync(join(cwd, config.store.dir, 'map.json'), 'utf8'),
    ) as CoverageMap;
    publishMap({ dir: archiveDirFor(cwd, config), map: local });
    rmSync(join(cwd, config.store.dir, 'map.json'));

    write('src/b.mjs', 'export const untested = () => 2;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'change b']);

    expect(
      (
        await fetchMap({
          cwd,
          dir: archiveDirFor(cwd, config),
          storeDir: config.store.dir,
        })
      ).ok,
    ).toBe(true);
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual([]);
  }, 60_000);
});
