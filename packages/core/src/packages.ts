import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
