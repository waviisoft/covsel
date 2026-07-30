import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageNameFromRelPath } from './packages.js';
import { DEFAULT_EXCLUDES, hashString } from './paths.js';

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

/** What a package could load first, as its manifest declares it. */
function entryCandidates(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (typeof value === 'string') out.push(value);
    else if (depth < 8 && typeof value === 'object' && value !== null) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
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
 * Every package directory reachable from one `node_modules`, as repo-relative
 * paths.
 *
 * Enumerated structurally rather than by walking the tree: a `node_modules` is
 * two levels deep in the shapes that matter and tens of thousands of files deep
 * overall, and only the package roots are of any interest.
 */
function packageDirs(cwd: string, nodeModulesRel: string, out: string[]): void {
  for (const name of subdirectories(join(cwd, nodeModulesRel))) {
    const rel = `${nodeModulesRel}/${name}`;
    if (name === '.pnpm') {
      // pnpm's virtual store: one directory per resolved package, each holding
      // a real `node_modules` with the package inside it.
      for (const entry of subdirectories(join(cwd, rel))) {
        packageDirs(cwd, `${rel}/${entry}/node_modules`, out);
      }
      continue;
    }
    if (name.startsWith('.')) continue; // .bin, .cache, and the markers
    if (name.startsWith('@')) {
      for (const scoped of subdirectories(join(cwd, rel))) {
        out.push(`${rel}/${scoped}`);
        packageDirs(cwd, `${rel}/${scoped}/node_modules`, out);
      }
      continue;
    }
    out.push(rel);
    packageDirs(cwd, `${rel}/node_modules`, out);
  }
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
  for (const root of nodeModulesRoots(cwd)) packageDirs(cwd, root, dirs);

  const inventory: Record<string, string[]> = {};
  for (const dir of dirs) {
    const name = packageNameFromRelPath(dir);
    if (name === undefined) continue;
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
  for (const versions of Object.values(inventory)) versions.sort();

  return { manager: found.manager, marker: found.marker, markerHash, inventory };
}
