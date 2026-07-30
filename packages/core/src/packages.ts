import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const VENDOR_DIR = 'node_modules';

/**
 * True when a repo-relative path is vendored code — anything below a
 * `node_modules` directory at any depth, which covers a workspace package's own
 * as well as the root's.
 *
 * Segment-wise, never a substring: a first-party `src/node_modules_shim/` is
 * this project's code and must not be mistaken for a dependency.
 */
export function isVendoredRelPath(rel: string): boolean {
  return rel.split('/').includes(VENDOR_DIR);
}

/**
 * The package a vendored file belongs to, or `undefined` when the path names no
 * package — first-party code, or a `node_modules` entry that is not a package.
 *
 * The rule is the one Node resolves by: the **innermost** enclosing
 * `node_modules` names the package. A dependency that bundles its own copy of
 * another is credited to the inner copy, which is what code inside it would
 * actually load. It also reads pnpm's virtual store with no knowledge of pnpm:
 * `node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js` has its
 * real `node_modules` last, so the store entry's flattened, version-suffixed
 * directory name is never what gets read. Node reports realpaths, so that is
 * the shape a pnpm project's coverage arrives in.
 *
 * Decided from path segments alone, with no filesystem access. This runs once
 * per executed script, which is hundreds of thousands of times over a suite;
 * reading the enclosing `package.json` instead would cost some fifty times as
 * much and force a cache to exist.
 *
 * A vendored path with no derivable name is **not** the same answer as
 * first-party code, and callers must not conflate them: use
 * `isVendoredRelPath` for that question. Vendored code covsel cannot attribute
 * has to keep falling open.
 */
export function packageNameFromRelPath(rel: string): string | undefined {
  const segments = rel.split('/');
  const vendor = segments.lastIndexOf(VENDOR_DIR);
  if (vendor === -1) return undefined;

  const first = segments[vendor + 1];
  // `node_modules` with nothing under it, and the package managers' own
  // bookkeeping — `.bin`, `.pnpm`, `.package-lock.json`. A leading dot is how
  // every one of them marks its files apart from the packages.
  if (first === undefined || first === '' || first.startsWith('.')) return undefined;
  if (!first.startsWith('@')) return first;

  // A scope is only ever half a name: `@scope` alone identifies no package.
  const scoped = segments[vendor + 2];
  return scoped === undefined || scoped === '' ? undefined : `${first}/${scoped}`;
}

/**
 * Whether a package is installed where this project would find it.
 *
 * The `node_modules` chain is walked from `cwd` upward by hand rather than taken
 * from `require.resolve.paths`, which mixes in the *calling* module's own chain:
 * asked from inside covsel, it happily reports covsel's dependencies as the
 * project's. A globally installed CLI would then answer about the wrong tree, and
 * the answer that matters here is what the project has.
 *
 * Walking upward is deliberate: it finds a dependency hoisted to a monorepo root,
 * exactly as the runner itself would. Presence is decided by the package
 * directory rather than by resolving an entry point, so a package that declares
 * only an `import` condition in its `exports` map — entirely ordinary, and just
 * what a modern dependency looks like — still reads as installed.
 */
export function isPackageInstalled(cwd: string, name: string): boolean {
  const segments = name.split('/');
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, 'node_modules', ...segments, 'package.json'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
