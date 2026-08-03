import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { hashString, readInstalledInventory } from '../src/index.js';

/**
 * What was installed when a map was recorded, so a later dependency change can
 * be resolved to the packages whose resolution actually moved.
 *
 * Two fail-open rules govern every case here. A package the recorder could
 * never have observed executing must stay *out* of the inventory, because a
 * package inside it that no entry mentions is read as "installed and never
 * ran" — and a bump to it would then select nothing. And a tree covsel cannot
 * prove fresh yields no inventory at all, because "nothing changed" computed
 * against a stale install is the answer that skips tests.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A project tree, from repo-relative path to file contents. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-inv-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","private":true}\n');
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return dir;
}

/** Create a repo-relative directory, returning its absolute path. */
function mkdirp(cwd: string, rel: string): string {
  const abs = join(cwd, rel);
  mkdirSync(abs, { recursive: true });
  return abs;
}

/** Symlink a repo-relative path at `target`, which may itself be relative. */
function link(cwd: string, rel: string, target: string): void {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  symlinkSync(target, join(cwd, rel));
}

/** A manifest for an ordinary JS package. */
function manifest(name: string, version: string, extra: object = {}): string {
  return `${JSON.stringify({ name, version, main: 'index.js', ...extra })}\n`;
}

/**
 * The package names an inventory holds. Most cases here are about which
 * packages are in it at all; the edges each one resolved through are the
 * subject of their own describe block below.
 */
function names(cwd: string): string[] {
  return Object.keys(readInstalledInventory(cwd)?.inventory ?? {}).sort();
}

/** The edges recorded for one package name. */
function edgesOf(cwd: string, name: string): string[] {
  return readInstalledInventory(cwd)?.inventory[name] ?? [];
}

/** The identity half of an edge -- what was resolved, dropping who resolved it. */
function storeEntry(edge: string): string {
  return edge.slice(edge.indexOf(':') + 1);
}

/**
 * A workspace where each package depends on its own version of `is-odd`, with
 * every version present in the store. Built by hand rather than installed, so
 * the shape under test is stated rather than inherited from a registry.
 */
function workspaceOn(importers: Record<string, string>): string {
  const files: Record<string, string> = {};
  for (const version of new Set(Object.values(importers))) {
    files[`node_modules/.pnpm/is-odd@${version}/node_modules/is-odd/package.json`] =
      manifest('is-odd', version);
  }
  const cwd = pnpmProject(files);
  for (const [name, version] of Object.entries(importers)) {
    link(
      cwd,
      `packages/${name}/node_modules/is-odd`,
      `../../../node_modules/.pnpm/is-odd@${version}/node_modules/is-odd`,
    );
  }
  return cwd;
}

/** A pnpm project: the store marker plus whatever else the case needs. */
function pnpmProject(files: Record<string, string>): string {
  return project({ 'node_modules/.pnpm/lock.yaml': 'lockfileVersion: 9.0\n', ...files });
}

describe('readInstalledInventory', () => {
  describe('proving the tree fresh', () => {
    it('reads pnpm store copy of the lockfile', () => {
      // pnpm writes a byte-identical copy of pnpm-lock.yaml into the store on
      // every install, so comparing the two is the whole freshness proof: no
      // parsing, and a lockfile pulled but not installed cannot match.
      const cwd = pnpmProject({});

      const inventory = readInstalledInventory(cwd);

      expect(inventory?.manager).toBe('pnpm');
      expect(inventory?.marker).toBe('node_modules/.pnpm/lock.yaml');
      expect(inventory?.markerHash).toBe(hashString('lockfileVersion: 9.0\n'));
    });

    it('reads npm hidden lockfile', () => {
      const cwd = project({ 'node_modules/.package-lock.json': '{"lockfileVersion":3}' });

      expect(readInstalledInventory(cwd)?.manager).toBe('npm');
      expect(readInstalledInventory(cwd)?.marker).toBe('node_modules/.package-lock.json');
    });

    it('reads yarn classic integrity file', () => {
      const cwd = project({ 'node_modules/.yarn-integrity': '{"systemParams":"linux"}' });

      expect(readInstalledInventory(cwd)?.manager).toBe('yarn');
    });

    it('reads yarn berry node-modules state', () => {
      const cwd = project({
        'node_modules/.yarn-state.yml': '__metadata:\n  version: 1',
      });

      expect(readInstalledInventory(cwd)?.manager).toBe('yarn-berry');
    });

    it('has no inventory for a manager that leaves no marker', () => {
      // bun and yarn's PnP linker install without writing anything covsel can
      // compare, so there is no way to tell a fresh tree from a stale one and
      // the only honest answer is none.
      const cwd = project({
        'bun.lockb': 'binary',
        'node_modules/left-pad/index.js': '',
      });

      expect(readInstalledInventory(cwd)).toBeUndefined();
    });

    it('has no inventory when two managers left markers', () => {
      // A repo that switched managers and did not clean up. Which install the
      // tree reflects is unknowable, so neither marker proves anything.
      const cwd = project({
        'node_modules/.pnpm/lock.yaml': 'lockfileVersion: 9.0\n',
        'node_modules/.package-lock.json': '{"lockfileVersion":3}',
      });

      expect(readInstalledInventory(cwd)).toBeUndefined();
    });

    it('has no inventory without a node_modules at all', () => {
      expect(readInstalledInventory(project({}))).toBeUndefined();
    });
  });

  describe('what is installed', () => {
    it('records a package and the version it is installed at', () => {
      const cwd = pnpmProject({
        'node_modules/left-pad/package.json': manifest('left-pad', '1.3.0'),
      });

      expect(names(cwd)).toEqual(['left-pad']);
    });

    it('keeps a scope with the name', () => {
      const cwd = pnpmProject({
        'node_modules/@scope/pkg/package.json': manifest('@scope/pkg', '2.0.0'),
      });

      expect(names(cwd)).toEqual(['@scope/pkg']);
    });

    it('reads through pnpm virtual store', () => {
      // The real shape: the package lives in the store and the project links to
      // it. The link is what makes it installed -- a store entry nothing points
      // at is an orphan pnpm has not got round to deleting.
      const cwd = pnpmProject({
        'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json': manifest(
          'left-pad',
          '1.3.0',
        ),
      });
      link(cwd, 'node_modules/left-pad', '.pnpm/left-pad@1.3.0/node_modules/left-pad');

      expect(names(cwd)).toEqual(['left-pad']);
    });

    it('follows a store entry to the dependencies it holds as siblings', () => {
      // pnpm keeps a package's dependencies beside it rather than beneath it,
      // so transitive dependencies are only found by following the links out of
      // each store entry.
      const cwd = pnpmProject({
        'node_modules/.pnpm/is-odd@3.0.1/node_modules/is-odd/package.json': manifest(
          'is-odd',
          '3.0.1',
        ),
        'node_modules/.pnpm/is-number@6.0.0/node_modules/is-number/package.json':
          manifest('is-number', '6.0.0'),
      });
      link(cwd, 'node_modules/is-odd', '.pnpm/is-odd@3.0.1/node_modules/is-odd');
      link(
        cwd,
        'node_modules/.pnpm/is-odd@3.0.1/node_modules/is-number',
        '../../is-number@6.0.0/node_modules/is-number',
      );

      expect(names(cwd)).toEqual(['is-number', 'is-odd']);
    });

    it('leaves out a store entry nothing depends on any more', () => {
      // pnpm never prunes its store, so a removed dependency stays on disk.
      // Reporting it as installed would make a removal look like no change at
      // all, and the tests whose imports it just broke would be skipped.
      const cwd = pnpmProject({
        'node_modules/.pnpm/kept@1.0.0/node_modules/kept/package.json': manifest(
          'kept',
          '1.0.0',
        ),
        'node_modules/.pnpm/dropped@2.0.0/node_modules/dropped/package.json': manifest(
          'dropped',
          '2.0.0',
        ),
      });
      link(cwd, 'node_modules/kept', '.pnpm/kept@1.0.0/node_modules/kept');

      expect(names(cwd)).toEqual(['kept']);
    });

    it('collects every version a name is installed at', () => {
      // Two copies of one name is ordinary: the project depends on one, and
      // something it depends on needs another. A bump to either has to be
      // visible, so recording one version would let the other move unnoticed.
      const cwd = pnpmProject({
        'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json': manifest(
          'left-pad',
          '1.3.0',
        ),
        'node_modules/.pnpm/left-pad@1.1.0/node_modules/left-pad/package.json': manifest(
          'left-pad',
          '1.1.0',
        ),
        'node_modules/.pnpm/old-consumer@1.0.0/node_modules/old-consumer/package.json':
          manifest('old-consumer', '1.0.0'),
      });
      link(cwd, 'node_modules/left-pad', '.pnpm/left-pad@1.3.0/node_modules/left-pad');
      link(
        cwd,
        'node_modules/old-consumer',
        '.pnpm/old-consumer@1.0.0/node_modules/old-consumer',
      );
      link(
        cwd,
        'node_modules/.pnpm/old-consumer@1.0.0/node_modules/left-pad',
        '../../left-pad@1.1.0/node_modules/left-pad',
      );

      expect(names(cwd)).toEqual(['left-pad', 'old-consumer']);
      // Both copies, not just the one the root importer got: a bump to either
      // has to be visible, and recording one would let the other move unseen.
      expect(edgesOf(cwd, 'left-pad')).toEqual([
        '.:node_modules/.pnpm/left-pad@1.3.0',
        'node_modules/.pnpm/old-consumer@1.0.0:node_modules/.pnpm/left-pad@1.1.0',
      ]);
    });

    it('finds a dependency bundled inside another', () => {
      const cwd = pnpmProject({
        'node_modules/outer/package.json': manifest('outer', '1.0.0'),
        'node_modules/outer/node_modules/inner/package.json': manifest('inner', '0.1.0'),
      });

      expect(names(cwd)).toEqual(['inner', 'outer']);
    });

    it('finds a workspace package own node_modules', () => {
      const cwd = pnpmProject({
        'packages/app/package.json': '{"name":"app"}',
        'packages/app/node_modules/local-only/package.json': manifest(
          'local-only',
          '3.0.0',
        ),
      });

      expect(names(cwd)).toEqual(['local-only']);
    });

    it('names a package by where it sits, not by what it calls itself', () => {
      // A directory whose manifest disagrees with it. Coverage attribution reads
      // the path, so the inventory reads the path too.
      const cwd = pnpmProject({
        'node_modules/aliased/package.json': manifest('the-real-name', '1.0.0'),
      });

      expect(names(cwd)).toEqual(['aliased']);
    });

    it('ignores the package managers own bookkeeping', () => {
      const cwd = pnpmProject({
        'node_modules/.bin/vitest': '#!/bin/sh\n',
        // A build cache with its own installed tree, which webpack and npm both
        // produce. Only refusing to descend into dot directories keeps it out:
        // the package below sits at a path that reads as an ordinary package,
        // so nothing downstream would reject it.
        'node_modules/.cache/node_modules/buried/package.json': manifest(
          'buried',
          '1.0.0',
        ),
      });

      expect(names(cwd)).toEqual([]);
    });
  });

  /**
   * What the inventory records per package, and why it is an edge rather than a
   * version.
   *
   * A version set answers "which versions are installed somewhere in this
   * repository". That is not the question. The question is whether the code a
   * given test runs has moved, and two ordinary situations move it while
   * leaving every version in place.
   */
  describe('resolution edges', () => {
    it('records who resolved a package and which copy they got', () => {
      const cwd = pnpmProject({
        'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json': manifest(
          'left-pad',
          '1.3.0',
        ),
      });
      link(cwd, 'node_modules/left-pad', '.pnpm/left-pad@1.3.0/node_modules/left-pad');

      // The store entry name is pnpm's own resolution identity, so covsel does
      // not have to invent one.
      // The identity names the store as well as the entry, because a
      // repository can hold more than one store and they name entries
      // independently.
      expect(edgesOf(cwd, 'left-pad')).toEqual(['.:node_modules/.pnpm/left-pad@1.3.0']);
    });

    it('moves when one importer swaps between versions others still hold', () => {
      // The case a version set cannot see: `a` moves from 3.0.1 to 2.0.0 while
      // `c` keeps 3.0.1, so the repo-wide set is {2.0.0, 3.0.1} before and
      // after. `a`'s tests now execute different code.
      const before = workspaceOn({ a: '3.0.1', b: '2.0.0', c: '3.0.1' });
      const after = workspaceOn({ a: '2.0.0', b: '2.0.0', c: '3.0.1' });

      // The identities on offer are the same set on both sides -- which is
      // precisely why a version comparison sees nothing here.
      const identities = (cwd: string): string[] =>
        [...new Set(edgesOf(cwd, 'is-odd').map(storeEntry))].sort();
      expect(identities(after)).toEqual(identities(before));

      expect(edgesOf(before, 'is-odd')).toContain(
        'packages/a:node_modules/.pnpm/is-odd@3.0.1',
      );
      expect(edgesOf(after, 'is-odd')).toContain(
        'packages/a:node_modules/.pnpm/is-odd@2.0.0',
      );
    });

    it('moves when a package is patched without its version changing', () => {
      // `pnpm patch` writes the patch hash into the store entry name and leaves
      // the manifest version alone, so the identity moves and the version does
      // not.
      const cwd = pnpmProject({
        'node_modules/.pnpm/is-odd@3.0.1_patch_hash=abc123/node_modules/is-odd/package.json':
          manifest('is-odd', '3.0.1'),
      });
      link(
        cwd,
        'node_modules/is-odd',
        '.pnpm/is-odd@3.0.1_patch_hash=abc123/node_modules/is-odd',
      );

      // The store entry also links to its own package, so the root importer's
      // edge is one of two rather than the only one.
      expect(edgesOf(cwd, 'is-odd')).toEqual([
        '.:node_modules/.pnpm/is-odd@3.0.1_patch_hash=abc123',
      ]);
    });

    it('tells two stores in one repository apart', () => {
      // A nested example app or an end-to-end project with its own lockfile is
      // walked like any other tree, and the two stores name their entries
      // independently. Comparing bare entry names would let a change in one
      // cancel out a change in the other.
      const cwd = pnpmProject({
        'node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json': manifest(
          'dep',
          '1.0.0',
        ),
        'sub/node_modules/.pnpm/dep@1.0.0/node_modules/dep/package.json': manifest(
          'dep',
          '1.0.0',
        ),
      });
      link(cwd, 'node_modules/dep', '.pnpm/dep@1.0.0/node_modules/dep');
      link(cwd, 'sub/node_modules/dep', '.pnpm/dep@1.0.0/node_modules/dep');

      expect(edgesOf(cwd, 'dep')).toEqual([
        '.:node_modules/.pnpm/dep@1.0.0',
        'sub:sub/node_modules/.pnpm/dep@1.0.0',
      ]);
    });

    it('names a node_modules by where it is, not by the path that reached it', () => {
      // `packages/app` depends on the workspace package `lib`, so `lib`'s own
      // `node_modules` is reachable two ways. Labelling it for whichever route
      // arrived first makes the recorded importer a matter of `readdirSync`
      // order, which differs between filesystems.
      const cwd = pnpmProject({
        'packages/lib/package.json': manifest('lib', '1.0.0'),
        'packages/app/package.json': manifest('app', '1.0.0'),
        'packages/lib/node_modules/dep/package.json': manifest('dep', '1.0.0'),
      });
      link(cwd, 'packages/app/node_modules/lib', '../../lib');

      expect(edgesOf(cwd, 'dep')).toEqual([
        'packages/lib:packages/lib/node_modules/dep@1.0.0',
      ]);
    });

    it('leaves out a package whose store entry names a directory rather than contents', () => {
      // A `file:` dependency is copied into the store under a name built from
      // the path it came from. Editing that directory and reinstalling leaves
      // the identity untouched while the code a test runs changes, so there is
      // nothing here worth comparing and the package falls open.
      const cwd = pnpmProject({
        'node_modules/.pnpm/shared@file+vendor+shared/node_modules/shared/package.json':
          manifest('shared', '1.0.0'),
      });
      link(
        cwd,
        'node_modules/shared',
        '.pnpm/shared@file+vendor+shared/node_modules/shared',
      );

      expect(names(cwd)).toEqual([]);
    });

    it('keeps a bundled copy distinct from its namesake under another parent', () => {
      // The npm and yarn shape the non-store identity exists for: one name, two
      // copies, each inside a different dependent.
      const cwd = pnpmProject({
        'node_modules/one/package.json': manifest('one', '1.0.0'),
        'node_modules/one/node_modules/dep/package.json': manifest('dep', '1.0.0'),
        'node_modules/two/package.json': manifest('two', '1.0.0'),
        'node_modules/two/node_modules/dep/package.json': manifest('dep', '2.0.0'),
      });

      expect(edgesOf(cwd, 'dep')).toEqual([
        'node_modules/one:node_modules/one/node_modules/dep@1.0.0',
        'node_modules/two:node_modules/two/node_modules/dep@2.0.0',
      ]);
    });

    it('identifies a package outside any store by where it sits and what it says', () => {
      // A hoisted tree, or a bundled dependency. The path alone does not say
      // which code is there, so the version comes along.
      const cwd = pnpmProject({
        'node_modules/flat/package.json': manifest('flat', '2.1.0'),
      });

      expect(edgesOf(cwd, 'flat')).toEqual(['.:node_modules/flat@2.1.0']);
    });
  });

  /**
   * The inventory and coverage attribution have to describe the same packages.
   * They see different things -- the walk sees `node_modules/<name>`, V8 reports
   * the realpath of what executed -- and where they disagree no entry can ever
   * credit the package, which reads as "installed and never ran".
   */
  describe('packages whose identity does not survive resolution', () => {
    it('keeps an ordinary pnpm package, linked into the store', () => {
      const cwd = pnpmProject({
        'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json': manifest(
          'left-pad',
          '1.3.0',
        ),
      });
      link(cwd, 'node_modules/left-pad', '.pnpm/left-pad@1.3.0/node_modules/left-pad');

      // The store path still reads as `left-pad`, so both sides agree.
      expect(names(cwd)).toEqual(['left-pad']);
    });

    it('drops a linked workspace package', () => {
      // What every monorepo has. Coverage for it arrives as first-party source
      // under `packages/core/`, never as vendored code, so no entry could name
      // it -- and covsel's own repository is shaped exactly this way.
      const cwd = pnpmProject({
        'packages/core/package.json': manifest('@scope/core', '1.0.0'),
        'packages/cli/package.json': '{"name":"@scope/cli"}',
      });
      mkdirSync(join(cwd, 'packages/cli/node_modules/@scope'), { recursive: true });
      link(cwd, 'packages/cli/node_modules/@scope/core', '../../../core');

      expect(names(cwd)).toEqual([]);
    });

    it('drops a package linked from outside the repository', () => {
      // `npm link`, `file:../shared`, yarn `portal:`. The realpath is not in the
      // repo at all, so nothing covsel records can ever mention it.
      const outside = mkdtempSync(join(tmpdir(), 'covsel-ext-'));
      dirs.push(outside);
      writeFileSync(join(outside, 'package.json'), manifest('ext', '9.9.9'));
      const cwd = pnpmProject({});
      link(cwd, 'node_modules/ext', outside);

      expect(names(cwd)).toEqual([]);
    });

    it('drops a pnpm aliased install', () => {
      // `aliased: npm:real@1.0.0`. pnpm links the alias straight at the store
      // entry for `real`, so attribution can only ever produce `real` -- and a
      // diff naming `aliased` would find it "installed and never run".
      const cwd = pnpmProject({
        'node_modules/.pnpm/real@1.0.0/node_modules/real/package.json': manifest(
          'real',
          '1.0.0',
        ),
      });
      link(cwd, 'node_modules/aliased', '.pnpm/real@1.0.0/node_modules/real');

      // `real` goes too, because the alias was its only way in: what is left is
      // the store entry's link to its own package, which names nothing the
      // inventory does not already have. Both fall open, which is the safe
      // direction for a name attribution can never produce.
      expect(names(cwd)).not.toContain('aliased');
    });

    it('terminates on a cycle of linked workspace packages', () => {
      // Workspace packages depending on each other, which pnpm permits and
      // monorepos with devDependency cycles produce routinely. Symlinks make
      // the walk a graph rather than a tree, and a cycle with any branching is
      // exponential rather than merely deep.
      //
      // Read this as a regression test for the answer, not for the hang: the
      // walk is synchronous, so a lost cycle guard blocks the worker and no
      // per-test timeout can turn that into a failure. It would stall the suite
      // rather than fail it, which is worth knowing before trusting the timeout
      // below to catch anything.
      const cwd = pnpmProject({});
      for (const name of ['a', 'b', 'c']) {
        writeFileSync(
          join(mkdirp(cwd, `packages/${name}`), 'package.json'),
          manifest(name, '1.0.0'),
        );
        mkdirp(cwd, `packages/${name}/node_modules`);
      }
      for (const from of ['a', 'b', 'c']) {
        for (const to of ['a', 'b', 'c']) {
          if (from !== to) {
            link(cwd, `packages/${from}/node_modules/${to}`, `../../${to}`);
          }
        }
      }

      expect(names(cwd)).toEqual([]);
    }, 20_000);
  });

  describe('packages no recorder could observe', () => {
    it('leaves out a package that ships no JavaScript', () => {
      // A platform binary such as @esbuild/linux-x64: an executable and a
      // README. No JS can execute, so no entry can ever credit it -- and a
      // package in the inventory that no entry credits reads as "ran nowhere",
      // which would skip every test on a bump. Out of the inventory, it falls
      // open instead.
      const cwd = pnpmProject({
        'node_modules/@plat/linux-x64/package.json': `${JSON.stringify({
          name: '@plat/linux-x64',
          version: '1.0.0',
          os: ['linux'],
          cpu: ['x64'],
        })}\n`,
        'node_modules/@plat/linux-x64/bin/tool': '#!/bin/sh\n',
      });

      expect(names(cwd)).toEqual([]);
    });

    it('leaves out a package whose only entry point is a native addon', () => {
      const cwd = pnpmProject({
        'node_modules/@plat/native/package.json': `${JSON.stringify({
          name: '@plat/native',
          version: '4.0.0',
          main: './native.linux-x64-gnu.node',
        })}\n`,
      });

      expect(names(cwd)).toEqual([]);
    });

    it('keeps a JS wrapper around a native addon', () => {
      // The wrapper executes, and V8 reports it, so covsel does see this
      // package run even though the work happens in the binary it opens.
      const cwd = pnpmProject({
        'node_modules/wrapper/package.json': manifest('wrapper', '1.0.0'),
        'node_modules/wrapper/index.js': 'process.dlopen();\n',
      });

      expect(names(cwd)).toEqual(['wrapper']);
    });

    it('keeps a package whose entry point is written without an extension', () => {
      const cwd = pnpmProject({
        'node_modules/extensionless/package.json': `${JSON.stringify({
          name: 'extensionless',
          version: '1.0.0',
          main: './lib/index',
        })}\n`,
      });

      expect(names(cwd)).toEqual(['extensionless']);
    });

    it('keeps a package that declares only an exports map', () => {
      const cwd = pnpmProject({
        'node_modules/modern/package.json': `${JSON.stringify({
          name: 'modern',
          version: '1.0.0',
          exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' } },
        })}\n`,
      });

      expect(names(cwd)).toEqual(['modern']);
    });

    it('keeps a package that declares nothing but ships an index', () => {
      const cwd = pnpmProject({
        'node_modules/implicit/package.json': `${JSON.stringify({
          name: 'implicit',
          version: '1.0.0',
        })}\n`,
        'node_modules/implicit/index.js': 'module.exports = 1;\n',
      });

      expect(names(cwd)).toEqual(['implicit']);
    });

    it('leaves out a types package, which declares an entry that runs nothing', () => {
      // `"main": ""` is how DefinitelyTyped says there is nothing to run. Read
      // as an entry point it admits every `@types/*` package in a project --
      // this repository has 27 -- none of which ships a line of JavaScript.
      const cwd = pnpmProject({
        'node_modules/@types/node/package.json': `${JSON.stringify({
          name: '@types/node',
          version: '22.20.1',
          main: '',
          types: 'index.d.ts',
        })}\n`,
        'node_modules/typesonly/package.json': `${JSON.stringify({
          name: 'typesonly',
          version: '1.0.0',
          exports: { '.': { types: './index.d.ts' } },
        })}\n`,
      });

      expect(names(cwd)).toEqual([]);
    });

    it('leaves out a package with no readable version', () => {
      // Nothing to compare a later tree against, so its silence proves nothing.
      const cwd = pnpmProject({
        'node_modules/unversioned/package.json': '{"name":"unversioned"}',
        'node_modules/broken/package.json': 'not json at all',
      });

      expect(names(cwd)).toEqual([]);
    });
  });
});
