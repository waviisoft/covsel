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
   * resolution edges that put it there, sorted.
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
 * The pnpm store entry a realpath sits in, as a repo-relative path, if it sits
 * in one.
 *
 * The entry name is the resolution identity pnpm already computed:
 * `is-odd@3.0.1`, `is-odd@3.0.1_patch_hash=00bb...` once patched,
 * `vite@8.0.0_@types+node@22.0.0` once peers are resolved, the commit for a git
 * specifier. Most of what a version cannot say about which code this is, that
 * name says.
 *
 * The store it lives in comes along with it. A repository can hold more than
 * one -- a nested example app or an end-to-end project with its own lockfile is
 * walked like any other -- and two stores name their entries independently, so
 * `is-odd@3.0.1` in one is a different package from `is-odd@3.0.1` in the
 * other. Comparing bare names lets a change in one cancel out a change in the
 * other.
 */
function storeEntryOf(rel: string): string | undefined {
  const segments = rel.split('/');
  const vendor = segments.lastIndexOf(VENDOR_DIR);
  return vendor >= 2 && segments[vendor - 2] === '.pnpm'
    ? segments.slice(0, vendor).join('/')
    : undefined;
}

/**
 * Specifier protocols pnpm writes into a store entry name that say *where* a
 * package came from without saying *what* it is.
 *
 * A registry tarball's name pins its version, a git specifier's pins the
 * commit, and a patch adds its hash. A `file:` or `link:` directory pins
 * nothing: the entry is named for the path it was copied from, so editing that
 * directory and reinstalling leaves the identity untouched while the code a
 * test runs changes. Those packages are left out, and fall open.
 *
 * A protocol not listed here is trusted, which is the wrong default for one
 * nobody has looked at -- but the alternative refuses every specifier covsel has
 * not seen, and that refuses the registry case this exists to serve.
 */
const UNPINNED_SPECIFIER = /^(?:file|link)\+/;

/**
 * The specifier half of a store entry name -- what follows the package name.
 *
 * Read positionally rather than by searching for a marker anywhere in the
 * string, because pnpm spells `/` as `+` in scoped names and in resolved peers
 * alike: a package under an `@link` scope is `@link+core@1.0.0`, and a peer on
 * one is `my-lib@1.0.0_@link+core@1.0.0`. Both contain the text a careless
 * check would read as a `link:` dependency.
 */
function specifierOf(entryPath: string): string {
  const entry = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  const at = entry.startsWith('@') ? entry.indexOf('@', 1) : entry.indexOf('@');
  return at === -1 ? '' : entry.slice(at + 1);
}

/** An edge from a store entry to the package that entry holds. */
function isSelfEdge(edge: string): boolean {
  const at = edge.indexOf(':');
  return edge.slice(0, at) === edge.slice(at + 1);
}

/** Whether a store entry names where a package came from rather than what it is. */
function namesALocation(entryPath: string): boolean {
  return UNPINNED_SPECIFIER.test(specifierOf(entryPath));
}

/**
 * What a package resolved to, as something two recordings can compare.
 *
 * A store entry names itself, store and all. Anything else -- a hoisted tree, a
 * bundled dependency -- is identified by where it really sits plus the version
 * it declares. That is weaker: a version is not a content hash, so a package
 * whose source changes without its version moving is invisible in that shape.
 * It is the best the layout offers, and it is why the store is where the
 * identity comes from wherever there is one.
 */
function identityOf(resolved: string, version: string): string | undefined {
  const entry = storeEntryOf(resolved);
  if (entry === undefined) return `${resolved}@${version}`;
  return namesALocation(entry) ? undefined : entry;
}

/**
 * Who owns the links inside one `node_modules`: a store entry by its own
 * identity, or an importer by its directory.
 */
function resolverOf(nodeModulesRel: string): string {
  const store = storeEntryOf(`${nodeModulesRel}/x`);
  if (store !== undefined) return store;
  const importer = nodeModulesRel.replace(/\/?node_modules$/, '');
  return importer === '' ? '.' : importer;
}

/** A package directory the walk found, and what resolved it. */
interface FoundPackage {
  /** Repo-relative path of the package directory, as the walk reached it. */
  dir: string;
  /**
   * Label for whatever holds the link: an importer by its directory, `.` at the
   * repository root, or a store entry by its own identity. Derived from where
   * that directory really is, so it does not depend on which path reached it.
   */
  resolver: string;
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
  out: FoundPackage[],
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

  // Labelled from where the directory really is, not from the path that got
  // here first. A `node_modules` reachable by several routes -- which is every
  // workspace package another workspace package depends on -- would otherwise
  // be named for whichever route `readdirSync` happened to yield first, and
  // that order differs between filesystems.
  const resolver = resolverOf(toRepoRelative(cwd, real) ?? nodeModulesRel);
  for (const name of subdirectories(join(cwd, nodeModulesRel))) {
    const rel = `${nodeModulesRel}/${name}`;
    // `.pnpm`, `.bin`, `.cache`, and the markers. The store is reached through
    // the packages that depend on its entries, never by listing it.
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const scoped of subdirectories(join(cwd, rel))) {
        recordPackage(cwd, `${rel}/${scoped}`, resolver, out, visited);
      }
      continue;
    }
    recordPackage(cwd, rel, resolver, out, visited);
  }
}

/** One package, plus everything reachable from it. */
function recordPackage(
  cwd: string,
  dir: string,
  resolver: string,
  out: FoundPackage[],
  visited: Set<string>,
): void {
  out.push({ dir, resolver });
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
 *
 * Returns the resolved path when it agrees, because that is also what names the
 * copy this package resolved to and re-reading it costs a syscall per package.
 */
function survivesResolution(cwd: string, dir: string, name: string): string | undefined {
  let resolved: string | undefined;
  try {
    resolved = toRepoRelative(cwd, realpathSync(join(cwd, dir)));
  } catch {
    return undefined;
  }
  return resolved !== undefined && packageNameFromRelPath(resolved) === name
    ? resolved
    : undefined;
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

  const dirs: FoundPackage[] = [];
  const visited = new Set<string>();
  for (const root of nodeModulesRoots(cwd)) packageDirs(cwd, root, dirs, visited);

  const inventory: Record<string, string[]> = {};
  for (const { dir, resolver } of dirs) {
    const name = packageNameFromRelPath(dir);
    if (name === undefined) continue;
    const resolved = survivesResolution(cwd, dir, name);
    if (resolved === undefined) continue;
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
    // The edge, not the version: which resolver got which copy. A version set
    // is unchanged by a patch and by an importer moving between two versions
    // that both stay installed, and in each case the code a test runs moved.
    const identity = identityOf(resolved, version);
    // No identity means the entry names a location rather than contents, so
    // this package has to fall open rather than be vouched for. The resolver
    // half is refused for the same reason and one more: a `file:` dependency's
    // entry is named for the path it was copied from, which may sit outside the
    // repository entirely, and the map is a published artifact.
    if (identity === undefined || namesALocation(resolver)) continue;
    const edge = `${resolver}:${identity}`;
    const edges = (inventory[name] ??= []);
    if (!edges.includes(edge)) edges.push(edge);
  }
  // Insertion order is `readdirSync` order, which differs between filesystems.
  // The map is compared byte for byte across shards and across runs, so the
  // ordering has to come from the names rather than from the host.
  //
  // A store entry links to its own package, and that edge usually says nothing
  // another edge does not -- a third of the edges on this repository were
  // these. Usually, not always: when the link that reached the entry was itself
  // dropped, as an aliased install's is, the self-edge is the only thing naming
  // that copy. Deciding that per name, once every edge is in, is the difference
  // between dropping a redundancy and dropping a package -- the unconditional
  // version lost the whole of `react-is` here, and with it any notice that one
  // of its copies had moved.
  const identity = (edge: string): string => edge.slice(edge.indexOf(':') + 1);
  const sorted: Record<string, string[]> = {};
  for (const name of Object.keys(inventory).sort()) {
    const edges = inventory[name]!;
    const named = new Set(edges.filter((e) => !isSelfEdge(e)).map(identity));
    sorted[name] = edges.filter((e) => !isSelfEdge(e) || !named.has(identity(e))).sort();
  }

  return { manager: found.manager, marker: found.marker, markerHash, inventory: sorted };
}
