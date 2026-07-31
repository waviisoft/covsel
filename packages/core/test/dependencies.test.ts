import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  changedPackages,
  dependencyOnlyManifestChange,
  treeIsProvablyCurrent,
} from '../src/index.js';

/**
 * The three questions that have to be answered before a lockfile change can be
 * anything other than a full run: has the tree really been installed, which
 * packages moved, and is this `package.json` edit about dependencies at all.
 *
 * Every one of them fails toward the full run covsel does today, so the worst
 * case costs exactly what the current behaviour costs.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-deps-'));
  dirs.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    rmSync(abs, { force: true });
    writeFileSync(abs, contents);
  }
  return dir;
}

const PNPM = {
  manager: 'pnpm',
  marker: 'node_modules/.pnpm/lock.yaml',
  markerHash: 'sha256:whatever',
  inventory: {},
};

describe('treeIsProvablyCurrent', () => {
  it('accepts a tree whose store copy matches the lockfile', () => {
    // pnpm copies the lockfile into the store on every install, so the two
    // agreeing is a proof rather than a heuristic -- and it is the only sound
    // freshness check available, because a tree stale for one reason can still
    // differ for another and hide the change being measured.
    const cwd = project({ 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' });
    writeFileSync(join(cwd, 'marker'), 'lockfileVersion: 9.0\n');

    expect(treeIsProvablyCurrent(cwd, { ...PNPM, marker: 'marker' }).current).toBe(true);
  });

  it('refuses a lockfile pulled without an install', () => {
    // The case the whole proof exists for: `git checkout` of a branch with a
    // different lockfile, or `pnpm install --lockfile-only`. The tree still
    // holds the old packages, so diffing inventories would report no change and
    // skip the tests for every package that really did move.
    const cwd = project({ 'pnpm-lock.yaml': 'lockfileVersion: 9.0\nnew: true\n' });
    writeFileSync(join(cwd, 'marker'), 'lockfileVersion: 9.0\n');

    const freshness = treeIsProvablyCurrent(cwd, { ...PNPM, marker: 'marker' });

    expect(freshness.current).toBe(false);
    expect(freshness.why).toContain('has changed since the last install');
  });

  it('refuses a tree with no marker at all', () => {
    const cwd = project({ 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n' });

    const freshness = treeIsProvablyCurrent(cwd, { ...PNPM, marker: 'missing' });

    expect(freshness.current).toBe(false);
    expect(freshness.why).toContain('could not be read');
  });

  it('refuses a manager whose marker proves nothing about the lockfile', () => {
    // npm and yarn write their own install state rather than a copy of the
    // lockfile, so "marker equals lockfile" is not a question that can be asked
    // of them. They keep falling open until that is worked out separately.
    const cwd = project({ 'package-lock.json': '{}' });
    writeFileSync(join(cwd, 'marker'), '{}');

    const freshness = treeIsProvablyCurrent(cwd, {
      ...PNPM,
      manager: 'npm',
      marker: 'marker',
    });

    // Answered on the manager, before the files are even opened: comparing them
    // would be comparing an npm install log against an npm lockfile, which
    // differ always and prove nothing.
    expect(freshness.current).toBe(false);
    expect(freshness.why).toContain('npm leaves no proof');
  });
});

describe('changedPackages', () => {
  it('names a package whose version moved', () => {
    expect(changedPackages({ 'left-pad': ['1.3.0'] }, { 'left-pad': ['1.1.3'] })).toEqual(
      ['left-pad'],
    );
  });

  it('says nothing about a package that did not move', () => {
    expect(
      changedPackages(
        { 'left-pad': ['1.3.0'], 'right-pad': ['1.0.1'] },
        { 'left-pad': ['1.1.3'], 'right-pad': ['1.0.1'] },
      ),
    ).toEqual(['left-pad']);
  });

  it('names a package that disappeared', () => {
    // A removal breaks every import of it, so the tests that ran it have to be
    // selected. Reading a removal as "no change" is the reading that skips them.
    expect(changedPackages({ gone: ['1.0.0'] }, {})).toEqual(['gone']);
  });

  it('names a package that appeared', () => {
    expect(changedPackages({}, { fresh: ['1.0.0'] })).toEqual(['fresh']);
  });

  it('notices a second copy arriving at a different version', () => {
    // One name at two versions is ordinary in a real tree, and a bump to either
    // copy has to count. Comparing only the first would let the other move
    // unnoticed.
    expect(
      changedPackages({ lodash: ['4.17.21'] }, { lodash: ['3.10.1', '4.17.21'] }),
    ).toEqual(['lodash']);
  });

  it('separates a name installed at no versions from one not installed', () => {
    // Recording never writes an empty version list, but a map from elsewhere
    // could, and reading the two as equal would hide a package appearing.
    expect(changedPackages({}, { odd: [] })).toEqual(['odd']);
  });

  it('is not confused by the order versions happen to be listed in', () => {
    expect(changedPackages({ a: ['1.0.0', '2.0.0'] }, { a: ['2.0.0', '1.0.0'] })).toEqual(
      [],
    );
  });
});

describe('dependencyOnlyManifestChange', () => {
  const manifest = (extra: object) =>
    JSON.stringify({ name: 'p', version: '1.0.0', ...extra });

  it('accepts a bump inside a dependency block', () => {
    expect(
      dependencyOnlyManifestChange(
        manifest({ dependencies: { 'left-pad': '1.3.0' } }),
        manifest({ dependencies: { 'left-pad': '1.1.3' } }),
      ),
    ).toBe(true);
  });

  it('accepts a change across several dependency blocks at once', () => {
    expect(
      dependencyOnlyManifestChange(
        manifest({ dependencies: { a: '1' }, devDependencies: { b: '1' } }),
        manifest({ dependencies: { a: '2' }, devDependencies: { b: '2' } }),
      ),
    ).toBe(true);
  });

  it('refuses a change to anything else', () => {
    // A `scripts` edit changes how the suite runs, and covsel has no way to
    // reason about that at all.
    expect(
      dependencyOnlyManifestChange(
        manifest({ scripts: { test: 'node --test' } }),
        manifest({ scripts: { test: 'vitest run' } }),
      ),
    ).toBe(false);
  });

  it('refuses a dependency change that comes with anything else', () => {
    expect(
      dependencyOnlyManifestChange(
        manifest({ dependencies: { a: '1' }, scripts: { test: 'x' } }),
        manifest({ dependencies: { a: '2' }, scripts: { test: 'y' } }),
      ),
    ).toBe(false);
  });

  it('refuses a key it has never heard of', () => {
    // An allowlist, never a denylist: the next field npm invents would otherwise
    // be admitted silently, and whatever it turns out to mean covsel would
    // already have decided it was safe.
    expect(
      dependencyOnlyManifestChange(
        manifest({ someNewFieldNpmInvented: 'a' }),
        manifest({ someNewFieldNpmInvented: 'b' }),
      ),
    ).toBe(false);
  });

  it('refuses a key that was added or removed outright', () => {
    expect(dependencyOnlyManifestChange(manifest({}), manifest({ scripts: {} }))).toBe(
      false,
    );
    expect(dependencyOnlyManifestChange(manifest({ scripts: {} }), manifest({}))).toBe(
      false,
    );
  });

  it('accepts a dependency block appearing or disappearing', () => {
    expect(
      dependencyOnlyManifestChange(manifest({}), manifest({ dependencies: { a: '1' } })),
    ).toBe(true);
  });

  it('refuses a manifest that parses identically despite the diff', () => {
    // Reformatted, or its line endings changed. Nothing is known to have moved,
    // which is not the same as knowing nothing moved.
    expect(dependencyOnlyManifestChange('{"name":"p"}', '{\n  "name": "p"\n}\n')).toBe(
      false,
    );
  });

  it('refuses either side being unreadable', () => {
    // A manifest covsel cannot parse says nothing about what changed in it.
    expect(dependencyOnlyManifestChange('not json', manifest({}))).toBe(false);
    expect(dependencyOnlyManifestChange(manifest({}), 'not json')).toBe(false);
    expect(dependencyOnlyManifestChange(undefined, manifest({}))).toBe(false);
  });
});
