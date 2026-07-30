import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  isPackageInstalled,
  isVendoredRelPath,
  packageNameFromRelPath,
} from '../src/index.js';

/**
 * Whether a package is installed is answered by looking for its directory
 * rather than by resolving an entry point, so an ESM-only package — no `require`
 * condition in its `exports` map, which is entirely ordinary — still reads as
 * installed.
 *
 * The case worth guarding hardest is the false positive: asked from inside
 * covsel, `require.resolve.paths` mixes in covsel's own dependency chain and
 * reports covsel's packages as the project's. These tests run inside covsel,
 * which has vitest installed, so a project without it must still read as not
 * having it.
 */

const dirs: string[] = [];

function project(packages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-pkg-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","private":true}\n');
  for (const [name, manifest] of Object.entries(packages)) {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), manifest);
  }
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('isPackageInstalled', () => {
  it('finds a package in the project node_modules', () => {
    const cwd = project({ 'left-pad': '{"name":"left-pad","version":"1.0.0"}' });

    expect(isPackageInstalled(cwd, 'left-pad')).toBe(true);
  });

  it('finds a scoped package', () => {
    const cwd = project({
      '@vitest/coverage-v8': '{"name":"@vitest/coverage-v8","version":"4.0.0"}',
    });

    expect(isPackageInstalled(cwd, '@vitest/coverage-v8')).toBe(true);
  });

  it('reports a package that is absent', () => {
    const cwd = project({});

    expect(isPackageInstalled(cwd, '@vitest/coverage-v8')).toBe(false);
  });

  it('finds an ESM-only package that require.resolve could not', () => {
    // No `require` condition and no `main`, so resolving an entry point throws.
    const cwd = project({
      'esm-only': '{"name":"esm-only","exports":{".":{"import":"./index.js"}}}',
    });

    expect(isPackageInstalled(cwd, 'esm-only')).toBe(true);
  });

  it('answers about the project tree, not covsel own location', () => {
    const cwd = project({});

    // vitest and its coverage provider are installed for this repo, and these
    // tests run inside it. Neither may read as installed for a project that
    // does not have them.
    expect(isPackageInstalled(cwd, 'vitest')).toBe(false);
    expect(isPackageInstalled(cwd, '@vitest/coverage-v8')).toBe(false);
  });

  it('finds a dependency hoisted to a parent directory', () => {
    // What a monorepo looks like: the package sits at the workspace root, and
    // the runner would find it from a nested project just the same.
    const root = project({ hoisted: '{"name":"hoisted","version":"1.0.0"}' });
    const nested = join(root, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), '{"name":"app"}\n');

    expect(isPackageInstalled(nested, 'hoisted')).toBe(true);
  });
});

/**
 * Which package a vendored file belongs to, decided from the path alone. The
 * rule is the one Node itself resolves by: the innermost enclosing
 * `node_modules` names the package, so a dependency bundled inside another
 * dependency is credited to the inner one.
 *
 * Path segments only, never the filesystem. Attribution runs once per executed
 * script — hundreds of thousands of times over a suite — and a `readFileSync`
 * of a `package.json` costs some fifty times what splitting the path does.
 */
describe('packageNameFromRelPath', () => {
  it('names the package a vendored file sits in', () => {
    expect(packageNameFromRelPath('node_modules/left-pad/index.js')).toBe('left-pad');
  });

  it('keeps the scope with the name', () => {
    expect(packageNameFromRelPath('node_modules/@scope/pkg/dist/index.js')).toBe(
      '@scope/pkg',
    );
  });

  it('credits the inner package when one dependency bundles another', () => {
    // What `require` inside `a` would resolve to, and therefore what a change
    // to the bundled copy actually affects.
    expect(packageNameFromRelPath('node_modules/a/node_modules/b/index.js')).toBe('b');
  });

  it('reads a workspace package own node_modules', () => {
    expect(packageNameFromRelPath('packages/cli/node_modules/foo/index.js')).toBe('foo');
  });

  it('sees through pnpm virtual store', () => {
    // pnpm installs into a content-addressed store and symlinks into it. Node
    // reports realpaths, so this is the shape every pnpm project's coverage
    // arrives in -- and the innermost-node_modules rule handles it with no
    // pnpm-specific parsing.
    expect(
      packageNameFromRelPath(
        'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js',
      ),
    ).toBe('left-pad');
  });

  it('sees through pnpm virtual store for a scoped package', () => {
    // The store flattens `@scope/pkg` to `@scope+pkg`, which is why the name is
    // read from the real directory below rather than from the store entry.
    expect(
      packageNameFromRelPath(
        'node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg/index.js',
      ),
    ).toBe('@scope/pkg');
  });

  it('sees through a pnpm store entry carrying peer suffixes', () => {
    expect(
      packageNameFromRelPath(
        'node_modules/.pnpm/vite@8.0.0_@types+node@22.0.0/node_modules/vite/dist/index.js',
      ),
    ).toBe('vite');
  });

  it('names the package directory itself', () => {
    expect(packageNameFromRelPath('node_modules/left-pad')).toBe('left-pad');
    expect(packageNameFromRelPath('node_modules/@scope/pkg')).toBe('@scope/pkg');
  });

  it('has no name for a path outside node_modules', () => {
    expect(packageNameFromRelPath('src/index.ts')).toBeUndefined();
  });

  it('does not mistake a path segment that merely contains the word', () => {
    expect(packageNameFromRelPath('src/node_modules_shim/index.ts')).toBeUndefined();
    expect(isVendoredRelPath('src/node_modules_shim/index.ts')).toBe(false);
  });

  it('has no name for the bookkeeping node_modules holds', () => {
    // Not packages, and no dependency change is ever attributable to them. A
    // leading dot is how every package manager marks its own files apart.
    expect(packageNameFromRelPath('node_modules/.package-lock.json')).toBeUndefined();
    expect(packageNameFromRelPath('node_modules/.bin/vitest')).toBeUndefined();
    expect(packageNameFromRelPath('node_modules/.pnpm/lock.yaml')).toBeUndefined();
  });

  it('has no name for a scope with no package under it', () => {
    expect(packageNameFromRelPath('node_modules/@scope')).toBeUndefined();
  });

  it('has no name for node_modules itself', () => {
    expect(packageNameFromRelPath('node_modules')).toBeUndefined();
    expect(packageNameFromRelPath('packages/cli/node_modules')).toBeUndefined();
  });

  it('leaves vendored code covsel cannot name recognisably vendored', () => {
    // The two answers are independent, and a caller must not read "no package
    // name" as "first-party code". Selection has to keep a vendored file it
    // cannot attribute on the falling-open side, and that is only possible
    // while these disagree.
    for (const rel of ['node_modules', 'node_modules/.bin/vitest']) {
      expect(isVendoredRelPath(rel), rel).toBe(true);
      expect(packageNameFromRelPath(rel), rel).toBeUndefined();
    }
  });
});

describe('isVendoredRelPath', () => {
  it('recognises vendored code at any depth', () => {
    expect(isVendoredRelPath('node_modules/left-pad/index.js')).toBe(true);
    expect(isVendoredRelPath('packages/cli/node_modules/foo/index.js')).toBe(true);
    expect(isVendoredRelPath('node_modules')).toBe(true);
  });

  it('leaves first-party code alone', () => {
    expect(isVendoredRelPath('src/index.ts')).toBe(false);
    expect(isVendoredRelPath('')).toBe(false);
  });
});
