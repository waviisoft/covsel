import { CONFIG_FILES, type CovselConfig } from './config.js';
import type { Change, Policy } from './interfaces.js';
import { makeMatcher, makeStrictMatcher } from './match.js';
import { type CoverageMap, isUsableMap, type TestId } from './schema.js';

/**
 * covsel's own config, changed since the map was recorded.
 *
 * A map is only meaningful under the configuration it was recorded with.
 * Narrowing `sourceGlobs` is the sharpest case: changes outside the new globs
 * stop counting as changes at all, while the map's `observed` scope still
 * covers them from the wider recording, so nothing else notices and the tests
 * that cover those files are quietly skipped.
 *
 * This is checked ahead of the project's own `sentinels` rather than added to
 * their defaults, because that list replaces wholesale when a project sets it —
 * and a project that tightens its sentinels should not lose the one that
 * protects the meaning of the map itself.
 */
function changedCovselConfig(changes: Change[]): string | undefined {
  const names = new Set<string>(CONFIG_FILES);
  return changes.find((c) => names.has(c.file))?.file;
}

/**
 * The first changed path the recording was not in a position to observe, if
 * any.
 *
 * Inside a map's `observed` globs, "no entry covers this file" is a measurement:
 * the recorder was watching and nothing ran. Outside them it is an artifact of
 * where the recorder was looking, and selecting on it skips tests the change can
 * break. So an unobserved change falls open instead.
 *
 * The globs are matched strictly. Every other glob set here is matched loosely,
 * because matching more of them runs more tests; this one is the exception, and
 * reading it loosely would let a path the recorder never covered pass as covered
 * and suppress the full run it should have caused.
 */
export function unobservedChange(
  map: CoverageMap,
  changes: Change[],
): string | undefined {
  const isObserved = makeStrictMatcher(map.observed);
  return changes.find((c) => !isObserved(c.file))?.file;
}

/**
 * Fail-open policy: every ambiguity resolves toward running more tests.
 *  - An unusable map, or one with no entries at all, forces a full run.
 *  - A change to covsel's own config forces a full run: the map means what it
 *    means only under the config it was recorded with.
 *  - Any change to a sentinel file forces a full run.
 *  - A change outside what the recording could observe forces a full run.
 *  - Added/changed test files always run, even before they are in the map.
 */
export class FailOpenPolicy implements Policy {
  private readonly isSentinel: (rel: string) => boolean;
  private readonly isTest: (rel: string) => boolean;

  constructor(config: Pick<CovselConfig, 'sentinels' | 'testGlobs'>) {
    this.isSentinel = makeMatcher(config.sentinels);
    this.isTest = makeMatcher(config.testGlobs);
  }

  evaluate(map: CoverageMap | undefined, changes: Change[]): 'select' | 'full-run' {
    if (!isUsableMap(map)) return 'full-run';
    // A map with no entries measured nothing, so its silence about a changed file
    // says nothing either. It is syntactically valid and structurally empty —
    // written by a recording that discovered no test files, or merged from
    // nothing — and reading it as "no test covers this" is how a run selects zero
    // tests and exits 0.
    if (map.entries.length === 0) return 'full-run';
    if (changedCovselConfig(changes) !== undefined) return 'full-run';
    if (changes.some((c) => this.isSentinel(c.file))) return 'full-run';
    if (unobservedChange(map, changes) !== undefined) return 'full-run';
    return 'select';
  }

  async mandatory(changes: Change[]): Promise<TestId[]> {
    return changes
      .filter((c) => (c.kind === 'added' || c.kind === 'modified') && this.isTest(c.file))
      .map((c) => ({ file: c.file }));
  }
}

/**
 * Human-readable reason a diff forces a full run (for logging/status).
 *
 * The map is taken as `unknown` because one of the answers here is about a map
 * that failed the schema check: typing it as a `CoverageMap` would make that
 * branch unreachable, and a caller holding a rejected map would have to invent
 * its own wording for the case this function already covers.
 */
export function fullRunReason(
  config: Pick<CovselConfig, 'sentinels'>,
  map: unknown,
  changes: Change[],
): string {
  if (map === undefined) return 'no usable map recorded';
  if (!isUsableMap(map)) return 'recorded map is stale or has an incompatible schema';
  if (map.entries.length === 0) return 'map has no entries, so it measured nothing';
  const configChange = changedCovselConfig(changes);
  if (configChange !== undefined) {
    return `${configChange} changed, so the map was recorded under a different configuration`;
  }
  const isSentinel = makeMatcher(config.sentinels);
  const hit = changes.find((c) => isSentinel(c.file));
  if (hit) return `sentinel changed: ${hit.file}`;
  const unobserved = unobservedChange(map, changes);
  if (unobserved !== undefined) {
    return `${unobserved} changed, which the recording could not observe`;
  }
  return 'full run';
}
