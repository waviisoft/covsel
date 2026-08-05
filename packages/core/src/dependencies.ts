import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CovselConfig } from './config.js';
import { fileAtCommit } from './git.js';
import type { Change } from './interfaces.js';
import { readInstalledInventory } from './inventory.js';
import { LOCKFILE_NAMES } from './lockfiles.js';
import type { CoverageMap, MapDependencies } from './schema.js';

/**
 * Deciding what a dependency change affects, given what a map recorded and what
 * the tree holds now.
 *
 * Every answer here fails toward the full run covsel does today, so the worst
 * case costs exactly what the current behaviour costs.
 */

/**
 * The lockfile each manager's marker can be compared against.
 *
 * Only pnpm is listed, and only because its marker *is* its lockfile, copied
 * byte for byte into the store on every install. npm and yarn write their own
 * install state in their own formats, so "the marker matches the lockfile" is
 * not a question that can be asked of them; proving their trees current means
 * something else, and they keep falling open until it is worked out.
 */
const LOCKFILE_MIRRORED_BY_MARKER: Record<string, string> = {
  pnpm: 'pnpm-lock.yaml',
};

/** Whether the tree can be trusted to reflect the lockfile, and why. */
export interface Freshness {
  current: boolean;
  /** Said out loud when a run falls open, so the cost is never a mystery. */
  why: string;
}

/**
 * Whether the installed tree provably reflects the lockfile as it stands.
 *
 * The case this exists for is a lockfile pulled but never installed — a
 * `git checkout` onto a branch with different dependencies, or
 * `pnpm install --lockfile-only`. The tree still holds the old packages, so
 * diffing inventories would report nothing changed and skip the tests for every
 * package that really did move.
 *
 * Note the asymmetry that makes this necessary: "the tree shows no difference"
 * is not a safe test on its own, because a tree stale for one reason can still
 * differ for another and hide the change being measured. The marker comparison
 * is the proof; the inventory diff is only meaningful once it holds.
 */
export function treeIsProvablyCurrent(cwd: string, deps: MapDependencies): Freshness {
  const lockfile = LOCKFILE_MIRRORED_BY_MARKER[deps.manager];
  if (lockfile === undefined) {
    return { current: false, why: `${deps.manager} leaves no proof its tree is current` };
  }
  let marker: string;
  let locked: string;
  try {
    marker = readFileSync(join(cwd, deps.marker), 'utf8');
    locked = readFileSync(join(cwd, lockfile), 'utf8');
  } catch {
    return { current: false, why: `${deps.marker} or ${lockfile} could not be read` };
  }
  return marker === locked
    ? { current: true, why: `${deps.marker} matches ${lockfile}` }
    : { current: false, why: `${lockfile} has changed since the last install` };
}

/**
 * Package names resolved differently than before, sorted.
 *
 * A name is changed when it appears on one side and not the other, or when the
 * resolution edges recorded for it differ — a package removed breaks every
 * import of it, a second copy arriving is a change to that name even though the
 * first copy stayed put, and an importer moving between copies is a change even
 * though both remain installed. Edges compare as sets, since the order a walk
 * found them in carries no meaning.
 *
 * This is only as good as what the inventory records, which is why that records
 * edges rather than versions: a version set is unchanged by `pnpm patch` and by
 * an importer swapping between two versions others still hold, and in both
 * cases the code a test runs moved.
 */
export function changedPackages(
  before: Record<string, string[]>,
  after: Record<string, string[]>,
): string[] {
  // Serialised rather than joined, and keyed on `undefined` outside the string
  // domain: any sentinel encoded *into* the string is a value some version list
  // can also produce, and the collision lands on exactly the foreign map the
  // distinction exists for.
  const key = (name: string, from: Record<string, string[]>): string =>
    Object.hasOwn(from, name) ? JSON.stringify([...from[name]!].sort()) : 'absent';
  const changed: string[] = [];
  // `Object.hasOwn`, because a package really can be called `constructor`, and
  // reading it off the prototype yields something that is neither absent nor a
  // list of versions.
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key(name, before) !== key(name, after)) changed.push(name);
  }
  return changed.sort();
}

/**
 * The manifest keys whose contents are only ever dependencies.
 *
 * An allowlist, never a denylist. The next field npm invents would otherwise be
 * admitted silently, and whatever it turned out to mean covsel would already
 * have decided a change to it was safe to select on.
 */
const DEPENDENCY_KEYS: ReadonlySet<string> = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/**
 * Whether a `package.json` edit changed nothing but its dependency blocks.
 *
 * `package.json` is a sentinel because almost anything in it can change what a
 * test does — `scripts` changes how the suite runs, `type` changes how every
 * module is parsed, `imports` changes what specifiers resolve to. Only a change
 * confined to the dependency blocks is one the inventory can account for.
 *
 * Either side being unreadable answers no: a manifest covsel cannot parse says
 * nothing about what changed in it.
 */
export function dependencyOnlyManifestChange(
  before: string | undefined,
  after: string | undefined,
): boolean {
  const parse = (text: string | undefined): Record<string, unknown> | undefined => {
    if (text === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const from = parse(before);
  const to = parse(after);
  if (from === undefined || to === undefined) return false;

  // Compared by serialisation rather than by identity, so a nested edit counts
  // and a key that merely got reordered does not.
  const differs = (key: string): boolean =>
    JSON.stringify(from[key]) !== JSON.stringify(to[key]);
  const touched = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter(
    differs,
  );
  // A manifest git reports as changed but which parses identically was edited
  // in a way covsel cannot see -- whitespace, line endings, byte order. Nothing
  // is known to have moved, which is not the same as knowing nothing moved, so
  // it keeps the sentinel's full run.
  return touched.length > 0 && touched.every((key) => DEPENDENCY_KEYS.has(key));
}

/** The manifest every package manager keeps its dependency blocks in. */
const MANIFEST = 'package.json';

/**
 * What a diff's dependency-related changes amount to.
 *
 * Three answers, and the middle one is why this is not a boolean. `undefined`
 * means the diff raises no dependency question at all, and everything proceeds
 * as it did before this existed.
 */
export type DependencyChange =
  | {
      /**
       * The changed files this answer speaks for. They stop being changes to
       * reason about as *files* -- the sentinel does not fire for them, and the
       * selector is never asked which tests cover a lockfile -- because their
       * whole content is the package axis below.
       */
      readonly accounted: readonly string[];
      /** Package names whose resolution moved since the map was recorded. */
      readonly packages: readonly string[];
      readonly fallOpen?: undefined;
    }
  | {
      readonly accounted?: undefined;
      readonly packages?: undefined;
      /** Why this dependency change could not be resolved to package names. */
      readonly fallOpen: string;
    };

/**
 * Resolve a diff's dependency changes to the packages whose resolution moved, or
 * say why they cannot be.
 *
 * This is the one place the lockfile sentinel is allowed to be downgraded, and
 * every precondition below has to hold before it is. The order is deliberate:
 * cheapest and most decisive first, so a project this can say nothing about pays
 * almost nothing to find that out.
 *
 * What makes the downgrade safe is that each precondition rules out a way the
 * comparison could be a lie rather than a measurement:
 *
 *  - **The map recorded an inventory.** Without one there is no "before" side,
 *    and every map recorded before that field existed is in exactly that
 *    position.
 *  - **The tree provably reflects the lockfile.** A lockfile pulled but not
 *    installed leaves the old packages on disk, so diffing inventories reports
 *    nothing changed and skips the tests for everything that really moved. Note
 *    the asymmetry: "the tree shows no difference" is not a safe test on its
 *    own, because a tree stale for one reason can still differ for another.
 *  - **The tree still yields an inventory now.** A project that switched to a
 *    layout covsel cannot identify packages in has no "after" side.
 *  - **Every changed package was installed at record time.** One that was not is
 *    a package the map never had an opinion about, and its silence is an
 *    artifact rather than a measurement -- the same distinction `observed`
 *    draws for paths.
 *
 * A manifest change is admitted only when every changed `package.json` moved
 * nothing but its dependency blocks. `makeMatcher` widens a slash-less sentinel
 * to basenames, so the sentinel fires for every workspace manifest, and the
 * question has to be asked of each one: a `scripts` block edited in one package
 * changes how that suite runs whatever the other manifests did.
 */
export function dependencyChange(init: {
  cwd: string;
  config: CovselConfig;
  map: CoverageMap;
  changes: readonly Change[];
}): DependencyChange | undefined {
  const { cwd, map, changes } = init;
  const lockfiles = new Set<string>(LOCKFILE_NAMES);
  const basename = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);

  const locks = changes.filter((c) => lockfiles.has(basename(c.file)));
  const manifests = changes.filter((c) => basename(c.file) === MANIFEST);
  if (locks.length === 0 && manifests.length === 0) return undefined;

  // Asked before anything expensive, and answered from the diff alone. A
  // manifest that moved something other than its dependency blocks is not a
  // dependency change at all, so this says nothing and the sentinel fires as it
  // always did -- no fall-open reason, because nothing here was downgraded.
  const base = map.commit;
  for (const manifest of manifests) {
    const before =
      base === undefined ? undefined : fileAtCommit(cwd, base, manifest.file);
    let after: string | undefined;
    try {
      after = readFileSync(join(cwd, manifest.file), 'utf8');
    } catch {
      after = undefined;
    }
    if (!dependencyOnlyManifestChange(before, after)) return undefined;
  }

  const recorded = map.dependencies;
  // Not a downgrade that failed -- a question this map cannot be asked, so it is
  // not asked, and the diff is answered exactly as it was before any of this
  // existed. The distinction is worth the branch for two reasons. Every map
  // recorded before the field existed is in this position, so this is the path
  // almost every real map takes, and "sentinel changed: pnpm-lock.yaml" is both
  // truer and more useful to its owner than a sentence about an inventory they
  // never opted into. And a project that deliberately dropped lockfiles from its
  // `sentinels` keeps the behaviour it chose, where a fall-open reason here would
  // quietly overrule it with a full run it had decided not to spend.
  if (recorded === undefined) return undefined;
  const freshness = treeIsProvablyCurrent(cwd, recorded);
  if (!freshness.current) return { fallOpen: freshness.why };

  const installed = readInstalledInventory(cwd);
  if (installed === undefined) {
    // A project that moved to a layout covsel cannot identify packages in --
    // `node-linker=hoisted`, npm, yarn -- and one degenerate case worth naming
    // because it looks like a bug from the outside: removing the last dependency
    // a project has leaves nothing to vouch for, which is reported as no
    // inventory, and this falls open. Correct, and invisible on any tree with
    // more than one package left standing.
    return { fallOpen: 'what is installed now cannot be established' };
  }
  // The marker proves the tree matches its lockfile; this proves both sides are
  // describing the same kind of tree. A repository that changed package manager
  // between recording and now satisfies the first and not the second.
  if (installed.manager !== recorded.manager) {
    return {
      fallOpen: `installed with ${installed.manager}, but the map was recorded under ${recorded.manager}`,
    };
  }

  const packages = changedPackages(recorded.inventory, installed.inventory);
  const unknown = packages.find((name) => !Object.hasOwn(recorded.inventory, name));
  if (unknown !== undefined) {
    return {
      fallOpen: `${unknown} was not installed when the map was recorded, so no entry could mention it`,
    };
  }

  return {
    accounted: [...locks, ...manifests].map((c) => c.file),
    packages,
  };
}
