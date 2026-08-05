/**
 * The one regex a runner takes to narrow a run to individual tests.
 *
 * Every runner that can select below the file level accepts a single pattern
 * over test names — node:test's `--test-name-pattern`, cucumber's `--name`,
 * Mocha's `--grep` — so a per-test adapter has to fold every affected name into
 * one alternation. Building it lives here rather than in each adapter because
 * the failure it prevents is silent: a name carrying `+`, `(`, or `.` compiles
 * to a perfectly valid regex that matches no test at all, and the run then
 * passes having executed none of the tests the diff affected.
 */

/** Characters that would otherwise be read as regex syntax rather than text. */
const METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * A regex source matching exactly the given test names and nothing else.
 *
 * Names are escaped so they match literally, and the alternation is anchored at
 * both ends so one name is not matched inside a longer title.
 *
 * Anchoring at the front is a claim about the runner: that what it matches
 * against is the name as recorded, not a title it has prefixed. node:test
 * matches each test's own name, and cucumber matches the scenario name, so both
 * hold. A runner that prefixes — Playwright puts the project and file in front —
 * would match *nothing* here rather than matching more, which is a selection
 * that skips every test it named; those take {@link testNameSuffixPattern}.
 *
 * Throws on an empty list, for the reason {@link alternation} gives.
 */
export function testNamePattern(names: readonly string[]): string {
  return `^(?:${alternation(names)})$`;
}

/** A run of tags a runner may have inserted into the title it matches against. */
const TAGS = '(?: @\\S+)*';

/**
 * A regex source matching any title *ending* in one of the given names, allowing
 * for tags the runner interleaves into it.
 *
 * For a runner that matches the pattern against a title it composed itself, out
 * of parts the recorded name cannot all carry. Playwright greps against
 * `<project> <file> <describes> <title>`, with each level's tags appended after
 * that level's own title — `cart.spec.ts checkout @slow pays @smoke` for a test
 * `pays` tagged `@smoke` inside a `checkout` describe tagged `@slow`.
 *
 * Two things follow, and both are fail-open concerns rather than tidiness.
 *
 * The **project** is a prefix no recorded name may include: a pattern anchored at
 * the front would have to name one browser, so a map recorded on Chromium would
 * select nothing at all when the suite runs on Firefox — the map skipping tests
 * through the very flag meant to narrow it. Hence the end anchor and no other.
 *
 * The **tags** sit *inside* the title, not after it, so a name is not a suffix of
 * the title it belongs to. `testInfo.titlePath` carries no tags and `testInfo.tags`
 * carries them flat, with nothing saying which level each came from, so the title
 * cannot be reconstructed from what a recorder can see. What can be done is to
 * allow tags wherever they may appear: between every word of the name, and at its
 * end. That over-matches — a title that really contains ` @something` between the
 * same words matches too — which runs more tests than named, the direction
 * selection is allowed to err in. Under-matching is not: a selection whose pattern
 * matches no test reports a green run that skipped every test the diff affected.
 *
 * Throws on an empty list, for the reason {@link testNamePattern} does.
 */
export function testNameSuffixPattern(names: readonly string[]): string {
  if (names.length === 0) throw new Error('cannot build a pattern from no test names');
  const tolerant = names.map((name) =>
    name
      .split(' ')
      .map((word) => word.replace(METACHARACTERS, '\\$&'))
      .join(`${TAGS} `),
  );
  return `(?:${tolerant.join('|')})${TAGS}$`;
}

/**
 * The names as one alternation of literals.
 *
 * Throws on an empty list. A pattern over no names matches nothing, so handing
 * one to a runner would report a green run that executed no test; callers with
 * nothing to name have nothing to run.
 */
function alternation(names: readonly string[]): string {
  if (names.length === 0) throw new Error('cannot build a pattern from no test names');
  return names.map((name) => name.replace(METACHARACTERS, '\\$&')).join('|');
}
