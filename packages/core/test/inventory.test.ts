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

      expect(readInstalledInventory(cwd)?.inventory).toEqual({ 'left-pad': ['1.3.0'] });
    });

    it('keeps a scope with the name', () => {
      const cwd = pnpmProject({
        'node_modules/@scope/pkg/package.json': manifest('@scope/pkg', '2.0.0'),
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({ '@scope/pkg': ['2.0.0'] });
    });

    it('reads through pnpm virtual store', () => {
      const cwd = pnpmProject({
        'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json': manifest(
          'left-pad',
          '1.3.0',
        ),
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({ 'left-pad': ['1.3.0'] });
    });

    it('collects every version a name is installed at', () => {
      // Two copies of one name is ordinary, and a bump to either has to be
      // visible. Recording one version would let the other move unnoticed.
      const cwd = pnpmProject({
        'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json': manifest(
          'left-pad',
          '1.3.0',
        ),
        'node_modules/.pnpm/left-pad@1.1.0/node_modules/left-pad/package.json': manifest(
          'left-pad',
          '1.1.0',
        ),
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({
        'left-pad': ['1.1.0', '1.3.0'],
      });
    });

    it('finds a dependency bundled inside another', () => {
      const cwd = pnpmProject({
        'node_modules/outer/package.json': manifest('outer', '1.0.0'),
        'node_modules/outer/node_modules/inner/package.json': manifest('inner', '0.1.0'),
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({
        outer: ['1.0.0'],
        inner: ['0.1.0'],
      });
    });

    it('finds a workspace package own node_modules', () => {
      const cwd = pnpmProject({
        'packages/app/package.json': '{"name":"app"}',
        'packages/app/node_modules/local-only/package.json': manifest(
          'local-only',
          '3.0.0',
        ),
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({
        'local-only': ['3.0.0'],
      });
    });

    it('names a package by where it sits, not by what it calls itself', () => {
      // A directory whose manifest disagrees with it. Coverage attribution reads
      // the path, so the inventory reads the path too.
      const cwd = pnpmProject({
        'node_modules/aliased/package.json': manifest('the-real-name', '1.0.0'),
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({ aliased: ['1.0.0'] });
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

      expect(readInstalledInventory(cwd)?.inventory).toEqual({});
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
      expect(readInstalledInventory(cwd)?.inventory).toEqual({ 'left-pad': ['1.3.0'] });
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

      expect(readInstalledInventory(cwd)?.inventory).toEqual({});
    });

    it('drops a package linked from outside the repository', () => {
      // `npm link`, `file:../shared`, yarn `portal:`. The realpath is not in the
      // repo at all, so nothing covsel records can ever mention it.
      const outside = mkdtempSync(join(tmpdir(), 'covsel-ext-'));
      dirs.push(outside);
      writeFileSync(join(outside, 'package.json'), manifest('ext', '9.9.9'));
      const cwd = pnpmProject({});
      link(cwd, 'node_modules/ext', outside);

      expect(readInstalledInventory(cwd)?.inventory).toEqual({});
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

      expect(readInstalledInventory(cwd)?.inventory).toEqual({ real: ['1.0.0'] });
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

      expect(readInstalledInventory(cwd)?.inventory).toEqual({});
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

      expect(readInstalledInventory(cwd)?.inventory).toEqual({});
    });

    it('leaves out a package whose only entry point is a native addon', () => {
      const cwd = pnpmProject({
        'node_modules/@plat/native/package.json': `${JSON.stringify({
          name: '@plat/native',
          version: '4.0.0',
          main: './native.linux-x64-gnu.node',
        })}\n`,
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({});
    });

    it('keeps a JS wrapper around a native addon', () => {
      // The wrapper executes, and V8 reports it, so covsel does see this
      // package run even though the work happens in the binary it opens.
      const cwd = pnpmProject({
        'node_modules/wrapper/package.json': manifest('wrapper', '1.0.0'),
        'node_modules/wrapper/index.js': 'process.dlopen();\n',
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({ wrapper: ['1.0.0'] });
    });

    it('keeps a package whose entry point is written without an extension', () => {
      const cwd = pnpmProject({
        'node_modules/extensionless/package.json': `${JSON.stringify({
          name: 'extensionless',
          version: '1.0.0',
          main: './lib/index',
        })}\n`,
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({
        extensionless: ['1.0.0'],
      });
    });

    it('keeps a package that declares only an exports map', () => {
      const cwd = pnpmProject({
        'node_modules/modern/package.json': `${JSON.stringify({
          name: 'modern',
          version: '1.0.0',
          exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' } },
        })}\n`,
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({ modern: ['1.0.0'] });
    });

    it('keeps a package that declares nothing but ships an index', () => {
      const cwd = pnpmProject({
        'node_modules/implicit/package.json': `${JSON.stringify({
          name: 'implicit',
          version: '1.0.0',
        })}\n`,
        'node_modules/implicit/index.js': 'module.exports = 1;\n',
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({ implicit: ['1.0.0'] });
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

      expect(readInstalledInventory(cwd)?.inventory).toEqual({});
    });

    it('leaves out a package with no readable version', () => {
      // Nothing to compare a later tree against, so its silence proves nothing.
      const cwd = pnpmProject({
        'node_modules/unversioned/package.json': '{"name":"unversioned"}',
        'node_modules/broken/package.json': 'not json at all',
      });

      expect(readInstalledInventory(cwd)?.inventory).toEqual({});
    });
  });
});
