/**
 * The measurements a replay produces, as pure functions over data a run
 * collected. Everything that decides what a number *means* lives here, so it can
 * be tested without cloning a repository or running a suite.
 */

/** How a single test file finished in one run of a suite. */
export type Outcome = 'passed' | 'failed';

/** Per-test-file outcomes from one run, keyed by repo-relative path. */
export type Outcomes = ReadonlyMap<string, Outcome>;

/** How large a change is, by the number of files it touched. */
export type Stratum = '1-3' | '4-10' | '11+';

/**
 * Test files whose outcome the change altered.
 *
 * A file the change *added* counts: it has no outcome at the base, so the change
 * is the reason it has one now. A file the change *deleted* does not, because it
 * cannot run at the head and demanding that selection name it is demanding a
 * test that no longer exists. The head run is therefore the set under
 * consideration, and the base run only says what each of those files used to do.
 */
export function changedOutcomes(base: Outcomes, head: Outcomes): string[] {
  const changed: string[] = [];
  for (const [file, after] of head) {
    if (base.get(file) !== after) changed.push(file);
  }
  return changed.sort();
}

/**
 * Test files already failing before the change, which the oracle cannot score.
 *
 * A verdict per file is one bit, so a file that failed at the base and fails at
 * the head reads as unchanged whatever the change did inside it — and can
 * therefore never be counted as a miss. A large repository at a pinned commit
 * routinely has a few, so reporting the count is what stops `misses: 0` from
 * being read as "every file was watched" when some of them never were.
 */
export function unscorable(base: Outcomes, head: Outcomes): string[] {
  const red: string[] = [];
  for (const file of head.keys()) {
    if (base.get(file) === 'failed') red.push(file);
  }
  return red.sort();
}

/**
 * The safety measurement: test files the change broke or fixed that selection
 * left out. This is the one number that must be zero — every entry in it is a
 * test whose behaviour the diff altered and which covsel decided not to run.
 *
 * A full run selects everything, so it can never miss; callers pass the full set
 * of discovered test files as `selected` in that case rather than an empty list.
 */
export function outcomeMisses(
  base: Outcomes,
  head: Outcomes,
  selected: readonly string[],
): string[] {
  const chosen = new Set(selected);
  return changedOutcomes(base, head).filter((file) => !chosen.has(file));
}

/** Selected test files split by what put them there. */
export interface SelectionSplit {
  /** Selected because a block or file they cover changed. */
  coverage: string[];
  /** Selected by a fail-open rule, whatever their coverage says. */
  policy: string[];
}

export interface SplitSelectionInit {
  selected: readonly string[];
  /** Test files the diff itself changed — always run, map or no map. */
  changedTestFiles: readonly string[];
  /** Test files matching the project's `alwaysRun` globs. */
  alwaysRun: readonly string[];
  /** Test files whose map entry credits no source at all. */
  creditingNoSource: readonly string[];
}

/**
 * Separate selection driven by coverage from selection driven by policy.
 *
 * Reporting a single ratio makes a fail-open improvement look like a precision
 * regression: a release that starts always running tests it cannot reason about
 * selects strictly more, and a benchmark that only counts files calls that
 * worse. Splitting the two keeps the safety rule and the selector's precision on
 * separate lines, where a reader can see which one moved.
 */
export function splitSelection(init: SplitSelectionInit): SelectionSplit {
  const byPolicy = new Set([
    ...init.changedTestFiles,
    ...init.alwaysRun,
    ...init.creditingNoSource,
  ]);
  const coverage: string[] = [];
  const policy: string[] = [];
  for (const file of [...init.selected].sort()) {
    (byPolicy.has(file) ? policy : coverage).push(file);
  }
  return { coverage, policy };
}

/** Selected test files over total discovered, or 1 when nothing was discovered. */
export function selectionRatio(selected: number, total: number): number {
  return total === 0 ? 1 : selected / total;
}

export interface Timings {
  /** Building the map. Paid once per base commit, not once per change. */
  recordMs: number;
  /** Deciding what to run. */
  affectedMs: number;
  /** Running the selected tests. */
  selectedMs: number;
  /** Running the whole suite. */
  fullMs: number;
}

/**
 * What a selected run costs against running everything, deciding included —
 * below 1 is a saving. `affectedMs` counts because a user pays it every time,
 * where recording is amortised across every change made from the same base.
 */
export function wallClockRatio(timings: Timings): number {
  if (timings.fullMs === 0) return 1;
  return (timings.affectedMs + timings.selectedMs) / timings.fullMs;
}

/**
 * How many changes must be selected from one recorded map before recording has
 * paid for itself.
 *
 * `undefined` means it never does: selecting cost at least as much as running
 * everything, so there is no number of repetitions that recovers the recording.
 * Reporting that as a large number instead of an absence would read as "worth it
 * eventually", which is the opposite of what it means.
 */
export function breakEvenRuns(timings: Timings): number | undefined {
  const savedPerRun = timings.fullMs - timings.selectedMs - timings.affectedMs;
  if (savedPerRun <= 0) return undefined;
  return Math.ceil(timings.recordMs / savedPerRun);
}

/** Which size bucket a change falls in, by how many files it touched. */
export function stratumOf(changedFiles: number): Stratum {
  if (changedFiles <= 3) return '1-3';
  if (changedFiles <= 10) return '4-10';
  return '11+';
}

/** The middle value, averaging the two middles for an even-length input. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
