/**
 * Compare covsel's idea of the suite against the runner's own.
 *
 * Every project running covsel maintains two answers to "which files are the
 * tests": the runner's (`include`/`testMatch`/`spec`) and covsel's `testGlobs`.
 * Nothing makes them agree, nothing notices when they stop, and the two ways
 * they can disagree fail very differently:
 *
 * A file the runner collects and covsel does not discover is never recorded, so
 * no change can select it, so under selection it never runs. The job stays
 * green and the suite is quietly smaller than anyone believes. That is a
 * fail-open violation of the worst kind -- not a test skipped noisily on a bad
 * map, but one that left the suite without saying so.
 *
 * A file covsel discovers and the runner does not collect is the reverse:
 * recording hands the runner a file it was configured not to run. Depending on
 * the runner that is a hard failure or an entry recorded as silence.
 *
 * The comparison itself is a set difference, and lives here rather than in a
 * consumer so that both directions are named once and mean the same thing to
 * everything that reports them.
 */

/**
 * What the two sets disagree about. Each side is sorted, so two runs against
 * one tree produce the same report, and reported separately, because the repair
 * differs: one widens the globs covsel discovers by, the other subtracts with
 * `testIgnore`.
 */
export interface SuiteDrift {
  /**
   * Files the runner collects that covsel does not discover.
   *
   * The dangerous direction. Each one runs today, is in no map, and can be
   * selected by no change -- so each is a test that silently leaves the suite
   * the moment selection is what decides what runs.
   */
  unselectable: string[];
  /**
   * Files covsel discovers that the runner does not collect.
   *
   * Each one is a file covsel would ask the runner to record and the runner was
   * configured not to run. Noisier than the other direction, and no less a
   * disagreement: it is what leaves a project with no map at all.
   */
  unrecordable: string[];
}

/**
 * Compare the files covsel discovered against the files the runner collects.
 *
 * Both are repo-relative POSIX paths. Neither side is required to be sorted or
 * free of duplicates: a runner may collect a file once per project or per
 * shard, and reading that as a disagreement would make the guard fire on every
 * run and be switched off within a day.
 */
export function compareSuites(
  discovered: readonly string[],
  collected: readonly string[],
): SuiteDrift {
  const byCovsel = new Set(discovered);
  const byRunner = new Set(collected);
  return {
    unselectable: [...byRunner].filter((f) => !byCovsel.has(f)).sort(),
    unrecordable: [...byCovsel].filter((f) => !byRunner.has(f)).sort(),
  };
}

/** Whether a report found anything at all. */
export function hasDrift(drift: SuiteDrift): boolean {
  return drift.unselectable.length > 0 || drift.unrecordable.length > 0;
}
