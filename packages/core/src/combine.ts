import type {
  CombinedUnit,
  FailedObservation,
  Observation,
  ObservationWindow,
} from './interfaces.js';
import type { CoveredBlock, CoveredFile, TestId } from './schema.js';

function label(test: TestId): string {
  return test.name === undefined ? test.file : `${test.file} "${test.name}"`;
}

function isFailed(window: ObservationWindow): window is FailedObservation {
  return 'failed' in window;
}

/**
 * Union the scopes of several windows onto one execution.
 *
 * Sound only because every window watched the *same* execution and the entry
 * they produce carries all of them: a glob any window claimed describes
 * something this entry really was watched for. That is what separates this from
 * {@link agreedScope}, which reduces scopes belonging to *different* recordings
 * and may not union them.
 *
 * The result is the globs as claimed — never a wider glob that happens to cover
 * them, and never `**` — because a scope is a claim about recall and widening
 * one suppresses full runs it should have caused.
 */
export function unionScopes(scopes: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const scope of scopes) {
    for (const glob of scope) {
      if (seen.has(glob)) continue;
      seen.add(glob);
      union.push(glob);
    }
  }
  return union;
}

/**
 * The scope shared by recordings that each observed only their own entries —
 * CI shards, or units a recorder observed through different windows.
 *
 * Their entries were watched by their own scope and no other, so a scope
 * covering all of them may claim only what they all claim. Disagreement yields
 * nothing rather than a union, which would let one recording's coverage vouch
 * for paths another was never watching; an empty scope puts every change
 * outside it, and falls open.
 *
 * Order within a scope carries no meaning, so scopes agree as sets; the result
 * keeps the first one's order.
 */
export function agreedScope(scopes: readonly (readonly string[])[]): string[] {
  const first = scopes[0];
  if (first === undefined) return [];
  const key = (scope: readonly string[]): string => JSON.stringify([...scope].sort());
  const shared = key(first);
  return scopes.every((scope) => key(scope) === shared) ? [...first] : [];
}

/**
 * Fold several observation windows onto one test into a single recorded unit.
 *
 * One Playwright test spans a browser isolate, the worker running the spec, and
 * usually a server the page talks to. Each is observed by its own mechanism, and
 * an entry built from any one of them is internally consistent, deterministic,
 * and quietly missing whole regions of the codebase. This unions them:
 *
 *  - Covered files union by path.
 *  - Blocks deduplicate by file and hash, and drop for any file a contributing
 *    window recorded *without* blocks — that window knows nothing about which of
 *    the file's blocks ran, and keeping the other's would let a change to a
 *    block only its isolate executed miss this entry. Selection falls back to
 *    file level per file, so this costs precision only where it is not known.
 *    A window that recorded nothing at all observed nothing execute, which is a
 *    measurement rather than missing block data, and costs nothing.
 *  - Scopes union, so the unit claims what the windows together could see and
 *    never more.
 *
 * A window that produced nothing usable fails the whole unit. Half a test's
 * execution recorded as all of it is exactly the map that skips tests: the
 * regions the failed window would have covered read as "ran nowhere". Callers
 * let this propagate — recording one test file fails, and no map is written.
 *
 * Combining no windows fails for the same reason: it would yield a well-formed
 * entry covering nothing, which selection reads as a test that covers no source
 * and skips on every diff.
 */
export function combineObservations(
  test: TestId,
  windows: readonly ObservationWindow[],
): CombinedUnit {
  if (windows.length === 0) {
    throw new Error(`no observations to combine for ${label(test)}`);
  }
  const failures = windows.filter(isFailed);
  if (failures.length > 0) {
    const reasons = failures.map((f) => f.failed).join('; ');
    throw new Error(
      `${label(test)}: ${failures.length} of ${windows.length} observation ` +
        `windows produced nothing usable: ${reasons}`,
    );
  }
  const observations = windows as readonly Observation[];

  const files = new Map<string, CoveredFile>();
  for (const observation of observations) {
    for (const file of observation.files) {
      if (!files.has(file.file)) files.set(file.file, file);
    }
  }

  // Files some window saw run but recorded no blocks for. Their block coverage
  // is unknown, not empty, so the combined unit records none for them.
  const withoutBlocks = new Set<string>();
  for (const observation of observations) {
    const blocky = new Set(observation.blocks.map((b) => b.file));
    for (const file of observation.files) {
      if (!blocky.has(file.file)) withoutBlocks.add(file.file);
    }
  }

  const blocks = new Map<string, CoveredBlock>();
  for (const observation of observations) {
    for (const block of observation.blocks) {
      if (withoutBlocks.has(block.file)) continue;
      blocks.set(`${block.file}\0${block.blockHash}`, block);
    }
  }

  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    test,
    files: [...files.values()].sort((a, b) => byPath(a.file, b.file)),
    blocks: [...blocks.values()].sort(
      (a, b) => byPath(a.file, b.file) || byPath(a.blockHash, b.blockHash),
    ),
    observes: unionScopes(observations.map((o) => o.observes)),
  };
}
