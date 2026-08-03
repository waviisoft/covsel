import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MapDependencies } from './schema.js';

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
