import type { CovselConfig } from './config.js';
import type { Change, Policy } from './interfaces.js';
import { makeMatcher } from './match.js';
import { type CoverageMap, isUsableMap, type TestId } from './schema.js';

/**
 * Fail-open policy: every ambiguity resolves toward running more tests.
 *  - An unusable map, or any change to a sentinel file, forces a full run.
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
  return hit ? `sentinel changed: ${hit.file}` : 'full run';
}
