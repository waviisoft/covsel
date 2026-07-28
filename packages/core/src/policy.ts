import type { CovselConfig } from './config.js';
import type { Change, Policy } from './interfaces.js';
import { makeMatcher } from './match.js';
import { type CoverageMap, isUsableMap, type TestId } from './schema.js';

/**
 * The first changed path the recording was not in a position to observe, if
 * any.
 *
 * Inside a map's `observed` globs, "no entry covers this file" is a measurement:
 * the recorder was watching and nothing ran. Outside them it is an artifact of
 * where the recorder was looking, and selecting on it skips tests the change can
 * break. So an unobserved change falls open instead.
 */
export function unobservedChange(
  map: CoverageMap,
  changes: Change[],
): string | undefined {
  const isObserved = makeMatcher(map.observed);
  return changes.find((c) => !isObserved(c.file))?.file;
}

/**
 * Fail-open policy: every ambiguity resolves toward running more tests.
 *  - An unusable map, or any change to a sentinel file, forces a full run.
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

/** Human-readable reason a diff forces a full run (for logging/status). */
export function fullRunReason(
  config: Pick<CovselConfig, 'sentinels'>,
  map: CoverageMap | undefined,
  changes: Change[],
): string {
  if (map === undefined) return 'no usable map recorded';
  if (!isUsableMap(map)) return 'recorded map is stale or has an incompatible schema';
  const isSentinel = makeMatcher(config.sentinels);
  const hit = changes.find((c) => isSentinel(c.file));
  if (hit) return `sentinel changed: ${hit.file}`;
  const unobserved = unobservedChange(map, changes);
  if (unobserved !== undefined) {
    return `${unobserved} changed, which the recording could not observe`;
  }
  return 'full run';
}
