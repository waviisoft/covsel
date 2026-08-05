import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commitAll, git, write } from './helpers/repo.js';
import {
  type CoverageMap,
  type CovselConfig,
  MAP_SCHEMA_VERSION,
  OBSERVES_EVERYTHING,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * Selecting on a dependency change instead of falling open on every lockfile
 * diff — covsel/covsel#47 phase 3.
 *
 * A lockfile change is a full run today, and dependency bumps are among the most
 * frequent diffs a repository sees. What makes downgrading that sentinel safe is
 * not one check but the conjunction of several, and the cases below are mostly
 * about the ways each of them can fail: every one of those has to end in the
 * full run covsel already does, because the alternative is a bump that skips the
 * test the new version breaks.
 *
 * Bumps are staged rather than installed. A prototype against real `pnpm
 * install` established that a hand-written bump — the store entry, the package
 * manifest, the top-level symlink, the lockfile, and the marker — produces the
 * identical changed set and identical selection to the real thing, which is what
 * makes fixtures at this level worth trusting. What a fixture cannot establish is
 * that pnpm keeps writing the marker last; that is measured in the issue, not
 * here.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LOCK_V1 = 'lockfileVersion: 9.0\nleft-pad: 1.3.0\n';
const LOCK_V2 = 'lockfileVersion: 9.0\nleft-pad: 1.4.0\n';

/** Where pnpm keeps a package: inside its store entry, under its own name. */
function storeDir(name: string, version: string): string {
  return `node_modules/.pnpm/${name}@${version}/node_modules/${name}`;
}

/** Install a package the way pnpm does, and link it into the root. */
function install(cwd: string, name: string, version: string): void {
  const dir = storeDir(name, version);
  write(
    cwd,
    `${dir}/package.json`,
    `${JSON.stringify({ name, version, main: 'index.js' })}\n`,
  );
  write(cwd, `${dir}/index.js`, 'module.exports = 1;\n');
  symlinkSync(join('..', dir), join(cwd, 'node_modules', name));
}

/**
 * A repository with two tests, one of which ran `left-pad`, and a map that says
 * so. The marker mirrors the lockfile, so the tree is provably current.
 */
function fixture(): { cwd: string; config: CovselConfig } {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-depsel-'));
  dirs.push(cwd);
  write(
    cwd,
    'package.json',
    `${JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '1.3.0' } }, null, 2)}\n`,
  );
  write(cwd, 'pnpm-lock.yaml', LOCK_V1);
  write(cwd, '.gitignore', '.covsel/\nnode_modules/\n');
  write(cwd, 'src/a.mjs', 'export const a = 1;\n');
  write(cwd, 'src/b.mjs', 'export const b = 2;\n');
  write(cwd, 'test/a.test.mjs', '// a\n');
  write(cwd, 'test/b.test.mjs', '// b\n');
  install(cwd, 'left-pad', '1.3.0');
  // A second package nothing runs, so the inventory is never emptied by the
  // cases below. An inventory that ends up vouching for nothing is reported as
  // none at all (#95), which falls open -- correct, but it would answer these
  // cases before the reasoning under test got a chance to.
  install(cwd, 'right-pad', '2.0.0');
  write(cwd, 'node_modules/.pnpm/lock.yaml', LOCK_V1);
  commitAll(cwd);

  const config = resolveConfig({
    sourceGlobs: ['src/**'],
    testGlobs: ['test/**/*.test.mjs'],
  });
  writeMap(cwd, config);
  return { cwd, config };
}

/** A map crediting `test/a.test.mjs` with left-pad and `test/b.test.mjs` with nothing. */
function writeMap(
  cwd: string,
  config: CovselConfig,
  // Deliberately loose: two cases below write a map covsel could not have
  // recorded — one with no `dependencies` at all — which is the whole point of
  // them, and `CoverageMap` is the type of maps that are well formed.
  overrides: Record<string, unknown> = {},
): void {
  const entry = (file: string, source: string, packages: string[]) => ({
    test: { file },
    files: [{ file: source, fileHash: `sha256:${source}` }],
    blocks: [],
    packages,
  });
  const map = {
    schemaVersion: MAP_SCHEMA_VERSION,
    recordedAt: new Date(0).toISOString(),
    granularity: 'file',
    observed: [...OBSERVES_EVERYTHING],
    commit: git(cwd, ['rev-parse', 'HEAD']),
    sentinelHashes: {},
    entries: [
      entry('test/a.test.mjs', 'src/a.mjs', ['left-pad']),
      entry('test/b.test.mjs', 'src/b.mjs', []),
    ],
    dependencies: {
      manager: 'pnpm',
      marker: 'node_modules/.pnpm/lock.yaml',
      markerHash: 'unused',
      inventory: {
        'left-pad': ['.:node_modules/.pnpm/left-pad@1.3.0'],
        'right-pad': ['.:node_modules/.pnpm/right-pad@2.0.0'],
      },
    },
    ...overrides,
  };
  write(cwd, `${config.store.dir}/map.json`, `${JSON.stringify(map, null, 2)}\n`);
}

/** Stage the bump a `pnpm update left-pad` would produce, marker and all. */
function bumpLeftPad(cwd: string): void {
  rmSync(join(cwd, 'node_modules/left-pad'));
  install(cwd, 'left-pad', '1.4.0');
  write(cwd, 'pnpm-lock.yaml', LOCK_V2);
  write(cwd, 'node_modules/.pnpm/lock.yaml', LOCK_V2);
}

describe('selecting on a dependency change', () => {
  it('runs only the tests that ran the bumped package', async () => {
    const { cwd, config } = fixture();
    bumpLeftPad(cwd);

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('runs the tests that ran a package the project dropped', async () => {
    // Removal is the case the inventory had to be built from reachability to
    // see at all (#83): the tests whose imports the removal just broke are
    // exactly the ones that must run.
    const { cwd, config } = fixture();
    rmSync(join(cwd, 'node_modules/left-pad'));
    write(cwd, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    write(cwd, 'node_modules/.pnpm/lock.yaml', 'lockfileVersion: 9.0\n');

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('selects nothing for a bump no test executed', async () => {
    // The common case a full run is being spent on today, and the whole value of
    // the feature. Sound only because the recorder was watching packages and
    // this one was installed at record time, so its absence from every entry is
    // a measurement rather than a gap.
    const { cwd, config } = fixture();
    rmSync(join(cwd, 'node_modules/right-pad'));
    install(cwd, 'right-pad', '2.1.0');
    write(cwd, 'pnpm-lock.yaml', LOCK_V2);
    write(cwd, 'node_modules/.pnpm/lock.yaml', LOCK_V2);

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual([]);
  });

  it('still selects on the sources that changed alongside the bump', async () => {
    // The two axes are independent, and a diff carrying both has to be answered
    // by both. Taking the lockfile out of the file axis must not take the rest
    // of the diff with it.
    const { cwd, config } = fixture();
    bumpLeftPad(cwd);
    write(cwd, 'src/b.mjs', 'export const b = 3;\n');

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  });
});

describe('dependency changes that must fall open', () => {
  it('falls open when the lockfile moved but nothing was installed', async () => {
    // `git checkout` onto a branch with other dependencies, or
    // `pnpm install --lockfile-only`. The tree still holds the old packages, so
    // diffing inventories reports nothing changed -- which is precisely the
    // answer that would skip every test for a package that really moved.
    const { cwd, config } = fixture();
    write(cwd, 'pnpm-lock.yaml', LOCK_V2);

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('pnpm-lock.yaml has changed since the last install');
  });

  it('falls open on a package that was not installed when the map was recorded', async () => {
    const { cwd, config } = fixture();
    install(cwd, 'new-dep', '1.0.0');
    write(cwd, 'pnpm-lock.yaml', LOCK_V2);
    write(cwd, 'node_modules/.pnpm/lock.yaml', LOCK_V2);

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('new-dep was not installed');
  });

  it('leaves a map with no inventory to the sentinel, in its own words', async () => {
    // Every map recorded before the field existed is in this position, so this
    // is the path almost every real map takes. Not a downgrade that failed but a
    // question this map cannot be asked, so the reason its owner reads is the
    // one that was always there rather than a sentence about a feature they
    // never opted into.
    const { cwd, config } = fixture();
    writeMap(cwd, config, { dependencies: undefined });
    bumpLeftPad(cwd);

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('sentinel changed: pnpm-lock.yaml');
  });

  it('falls open when the manifest moved something other than dependencies', async () => {
    // `scripts` changes how the suite runs. The sentinel fires as it always
    // did -- this is not a dependency change at all, so nothing was downgraded.
    const { cwd, config } = fixture();
    bumpLeftPad(cwd);
    write(
      cwd,
      'package.json',
      `${JSON.stringify({ name: 'fixture', scripts: { test: 'x' }, dependencies: { 'left-pad': '1.4.0' } }, null, 2)}\n`,
    );

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('sentinel changed: package.json');
  });

  it('admits a manifest edit confined to the dependency blocks', async () => {
    const { cwd, config } = fixture();
    bumpLeftPad(cwd);
    write(
      cwd,
      'package.json',
      `${JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '1.4.0' } }, null, 2)}\n`,
    );

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('falls open when the tree was installed by another package manager', async () => {
    const { cwd, config } = fixture();
    bumpLeftPad(cwd);
    writeMap(cwd, config, {
      dependencies: {
        manager: 'npm',
        marker: 'node_modules/.package-lock.json',
        markerHash: 'unused',
        inventory: { 'left-pad': ['.:node_modules/.pnpm/left-pad@1.3.0'] },
      },
    });

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('npm leaves no proof');
  });

  it('falls open when an entry says nothing about packages', async () => {
    // The map claims an inventory while an entry disclaims the question, which
    // recording and merging both make impossible -- so a map in this shape was
    // hand-edited or came from elsewhere, and cannot be reasoned about.
    const { cwd, config } = fixture();
    const mapPath = join(cwd, config.store.dir, 'map.json');
    const map = JSON.parse(readFileSync(mapPath, 'utf8')) as CoverageMap & {
      entries: { packages?: string[] }[];
    };
    delete map.entries[1]!.packages;
    writeFileSync(mapPath, JSON.stringify(map, null, 2));
    bumpLeftPad(cwd);

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('says nothing about packages');
  });
});
