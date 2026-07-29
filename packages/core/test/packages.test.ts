import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { isPackageInstalled } from '../src/index.js';

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
