import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { packageNameFromRelPath } from './packages.js';
import { DEFAULT_EXCLUDES, hashString, toRepoRelative } from './paths.js';

/**
 * What was installed when a map was recorded.
 *
 * The "before" side of a dependency change needs no second install, because a
 * map already records the state it was recorded against — that is what
 * `sentinelHashes` and `fileHash` are. This is one more such record.
 */
export interface InstalledInventory {
  /** The package manager whose installed tree this describes. */
  manager: string;
  /** Repo-relative path of that manager's install marker. */
  marker: string;
  /** Content hash of the marker at record time. */
  markerHash: string;
  /**
   * Every installed package covsel could have observed executing, and the
   * versions it was installed at, sorted.
   *
   * Keyed the way coverage attribution names a package — by the directory it
   * sits in, not by what its manifest calls itself. An aliased install puts one
   * package under another's name, and the two sides have to agree or a bump to
   * the alias would match no entry.
   */
  inventory: Record<string, string[]>;
}

/**
 * How each package manager proves its `node_modules` matches its lockfile.
 *
 * A lockfile pulled but never installed is the case that has to be caught: the
 * tree would show no difference from the map's inventory, "nothing changed"
 * would be the answer, and the tests for the packages that really did move
 * would be skipped. Every manager here writes something into `node_modules` on
 * install that a later comparison can be built on — pnpm a byte-identical copy
 * of its lockfile, the others their own install state.
 *
 * bun and yarn's PnP linker write nothing usable, so a project on either has no
 * inventory and keeps falling open on every lockfile change.
 */
const MARKERS: readonly { manager: string; marker: string }[] = [
  { manager: 'pnpm', marker: 'node_modules/.pnpm/lock.yaml' },
  { manager: 'npm', marker: 'node_modules/.package-lock.json' },
  { manager: 'yarn', marker: 'node_modules/.yarn-integrity' },
  { manager: 'yarn-berry', marker: 'node_modules/.yarn-state.yml' },
];

/** Extensions an entry point can carry that no V8 coverage will ever report. */
const OPAQUE_ENTRY = /\.(node|wasm|json)$/;

const VENDOR_DIR = 'node_modules';

/**
 * What a package could load first, as its manifest declares it.
 *
 * The `types` condition is skipped: it names a declaration file, which the
 * compiler reads and no runtime ever executes. A package whose `exports` offer
 * nothing else ships no JavaScript however many entries it lists.
 */
function entryCandidates(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  const collect = (value: unknown, depth: number): void => {
    // `"main": ""` is how DefinitelyTyped says "there is nothing to run here".
    // Counted as an entry point it would admit every `@types/*` package, none
    // of which ships a line of JavaScript.
    if (typeof value === 'string') {
      if (value !== '') out.push(value);
    } else if (depth < 8 && typeof value === 'object' && value !== null) {
      for (const [condition, nested] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (condition === 'types') continue;
        collect(nested, depth + 1);
      }
    }
  };
  collect(manifest['main'], 0);
  collect(manifest['module'], 0);
  collect(manifest['exports'], 0);
  return out;
}

/**
 * Whether any JavaScript in this package could show up in a recording.
 *
 * A package that ships none — a platform binary such as `@esbuild/linux-x64`,
 * whose whole payload is an executable, or one whose only entry point is a
 * `.node` addon — can never be credited to a test, however much a test leans on
 * it. Leaving such a package in the inventory would make its silence read as
 * "installed and never ran", and a bump to it would then select nothing. Out of
 * the inventory it falls open instead, which is the only safe answer for a
 * package no recorder was ever in a position to watch.
 *
 * A JS wrapper around a native addon does not qualify: the wrapper executes,
 * V8 reports it, and covsel sees the package run.
 */
function shipsObservableJs(dir: string, manifest: Record<string, unknown>): boolean {
  const candidates = entryCandidates(manifest);
  if (candidates.length > 0) {
    // An extension-less specifier resolves to JavaScript, so only an explicitly
    // opaque one is disqualifying.
    return candidates.some((entry) => !OPAQUE_ENTRY.test(entry));
  }
  return ['index.js', 'index.mjs', 'index.cjs'].some((f) => existsSync(join(dir, f)));
}

/** Directory entries, or nothing when the directory is unreadable. */
function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The `node_modules` holding a store entry's own dependencies, if this package
 * lives in pnpm's virtual store.
 *
 * pnpm keeps each resolved package in its own store entry, and that entry's
 * `node_modules` holds the package itself alongside a symlink per dependency:
 *
 *     node_modules/.pnpm/is-odd@3.0.1/node_modules/
 *       is-odd                                      <- the package
 *       is-number -> ../../is-number@6.0.0/node_modules/is-number
 *
 * So the store is a graph to be followed from what the project depends on, not
 * a directory to be listed. Following it is what keeps transitive dependencies
 * in the inventory once the store is no longer enumerated wholesale.
 */
function storeSiblings(cwd: string, packageRealAbs: string): string | undefined {
  const rel = toRepoRelative(cwd, packageRealAbs);
  if (rel === undefined) return undefined;
  const segments = rel.split('/');
  const vendor = segments.lastIndexOf(VENDOR_DIR);
  // `<...>/.pnpm/<entry>/node_modules/<name>`: the store marker sits two above
  // the `node_modules` the package is in.
  if (vendor < 2 || segments[vendor - 2] !== '.pnpm') return undefined;
  return segments.slice(0, vendor + 1).join('/');
}

/**
 * Every package directory reachable from one `node_modules`, as repo-relative
 * paths.
 *
 * Reachability, not contents. pnpm never prunes its virtual store, so a package
 * removed from the project stays on disk indefinitely; listing the store would
 * keep reporting it as installed, and a dependency that was *dropped* would
 * then look like no change at all -- skipping the tests whose imports it just
 * broke. Nothing links to an orphan, so following links from what the project
 * actually depends on leaves it out.
 *
 * Enumerated structurally rather than by walking the tree: only package roots
 * are of any interest, and an installed tree is tens of thousands of files
 * deep.
 */
function packageDirs(
  cwd: string,
  nodeModulesRel: string,
  out: string[],
  visited: Set<string>,
): void {
  // Symlinks are followed, so the graph being walked is not a tree: a monorepo
  // whose workspace packages depend on each other links them into
  // `node_modules` in both directions, and a cycle with any branching is
  // exponential rather than merely infinite. Depth alone bounds nothing --
  // without this the walk runs until a path grows past PATH_MAX, or forever.
  let real: string;
  try {
    real = realpathSync(join(cwd, nodeModulesRel));
  } catch {
    return;
  }
  if (visited.has(real)) return;
  visited.add(real);

  for (const name of subdirectories(join(cwd, nodeModulesRel))) {
    const rel = `${nodeModulesRel}/${name}`;
    // `.pnpm`, `.bin`, `.cache`, and the markers. The store is reached through
    // the packages that depend on its entries, never by listing it.
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const scoped of subdirectories(join(cwd, rel))) {
        recordPackage(cwd, `${rel}/${scoped}`, out, visited);
      }
      continue;
    }
    recordPackage(cwd, rel, out, visited);
  }
}

/** One package, plus everything reachable from it. */
function recordPackage(
  cwd: string,
  dir: string,
  out: string[],
  visited: Set<string>,
): void {
  out.push(dir);
  // A dependency bundled inside this package, the npm and yarn shape.
  packageDirs(cwd, `${dir}/node_modules`, out, visited);
  // Its dependencies as pnpm arranges them, which are siblings rather than
  // children. Resolved from the realpath, because the entry covsel is looking
  // at is usually the symlink pointing into the store.
  let realAbs: string;
  try {
    realAbs = realpathSync(join(cwd, dir));
  } catch {
    return;
  }
  const siblings = storeSiblings(cwd, realAbs);
  if (siblings !== undefined) packageDirs(cwd, siblings, out, visited);
}

/**
 * Every `node_modules` directory in the repository: the root's, and any a
 * workspace package keeps of its own. Walks the source tree, which is small,
 * rather than descending into the installed trees, which are not.
 */
function nodeModulesRoots(cwd: string): string[] {
  const skip = new Set<string>(DEFAULT_EXCLUDES);
  const roots: string[] = [];
  const visit = (relDir: string): void => {
    for (const name of subdirectories(join(cwd, relDir))) {
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      if (name === 'node_modules') roots.push(rel);
      else if (!skip.has(name) && !name.startsWith('.')) visit(rel);
    }
  };
  visit('');
  return roots;
}

/**
 * Whether a package still names the same package once the links are followed.
 *
 * The inventory and coverage attribution have to describe the same packages,
 * and they see different things: the walk sees `node_modules/<name>`, while V8
 * reports the realpath of whatever actually executed. Where the two disagree,
 * no entry can ever credit the package, and a package in the inventory that no
 * entry credits reads as "installed and never ran" -- the one inference that
 * skips tests.
 *
 * Three shapes disagree, and all three are ordinary:
 *
 * - **A linked workspace package.** `packages/cli/node_modules/@covsel/core`
 *   resolves to `packages/core`, and its coverage arrives as first-party source
 *   under `packages/core/src`, never as vendored code.
 * - **A linked external package** -- `npm link`, `file:../shared`, yarn
 *   `portal:` -- resolves outside the repository entirely.
 * - **An aliased install.** pnpm links `node_modules/aliased` at the store entry
 *   for `real`, so attribution can only ever produce `real`.
 *
 * Each is dropped, and each then falls open. The ordinary pnpm case is
 * unaffected: `node_modules/left-pad` resolves into the store at
 * `.pnpm/left-pad@1.3.0/node_modules/left-pad`, which still reads as `left-pad`.
 */
function survivesResolution(cwd: string, dir: string, name: string): boolean {
  let resolved: string | undefined;
  try {
    resolved = toRepoRelative(cwd, realpathSync(join(cwd, dir)));
  } catch {
    return false;
  }
  return resolved !== undefined && packageNameFromRelPath(resolved) === name;
}

/**
 * What the project has installed, and the proof that the install is current —
 * or `undefined` when covsel cannot establish either.
 *
 * Returning nothing is always safe: a map with no inventory falls open on every
 * dependency change, which is what covsel does today for every project.
 */
export function readInstalledInventory(cwd: string): InstalledInventory | undefined {
  const present = MARKERS.filter((m) => existsSync(join(cwd, m.marker)));
  // Two managers' markers means a tree that was installed twice, or once and
  // then switched. Which install it reflects is unknowable, so neither marker
  // proves anything and there is nothing to be gained by guessing.
  if (present.length !== 1) return undefined;
  const found = present[0]!;

  let markerHash: string;
  try {
    markerHash = hashString(readFileSync(join(cwd, found.marker), 'utf8'));
  } catch {
    return undefined;
  }

  const dirs: string[] = [];
  const visited = new Set<string>();
  for (const root of nodeModulesRoots(cwd)) packageDirs(cwd, root, dirs, visited);

  const inventory: Record<string, string[]> = {};
  for (const dir of dirs) {
    const name = packageNameFromRelPath(dir);
    if (name === undefined) continue;
    if (!survivesResolution(cwd, dir, name)) continue;
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(cwd, dir, 'package.json'), 'utf8'),
      );
      if (typeof parsed !== 'object' || parsed === null) continue;
      manifest = parsed as Record<string, unknown>;
    } catch {
      continue; // not a package, or one covsel cannot read: it falls open
    }
    const version = manifest['version'];
    if (typeof version !== 'string' || version === '') continue;
    if (!shipsObservableJs(join(cwd, dir), manifest)) continue;
    const versions = (inventory[name] ??= []);
    if (!versions.includes(version)) versions.push(version);
  }
  // Insertion order is `readdirSync` order, which differs between filesystems.
  // The map is compared byte for byte across shards and across runs, so the
  // ordering has to come from the names rather than from the host.
  const sorted: Record<string, string[]> = {};
  for (const name of Object.keys(inventory).sort())
    sorted[name] = inventory[name]!.sort();

  return { manager: found.manager, marker: found.marker, markerHash, inventory: sorted };
}
