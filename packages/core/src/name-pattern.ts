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

/**
 * A regex source matching any title *ending* in one of the given names.
 *
 * For a runner that matches the pattern against a title it has prefixed with
 * something the recorded name cannot include. Playwright greps against
 * `<project> <file> <describes> <title>`, and the project name is the prefix
 * that matters: a pattern anchored at the front would have to name one browser,
 * and a map recorded on Chromium would then select nothing when the suite runs
 * on Firefox — the map skipping tests through the very flag meant to narrow it.
 *
 * Anchored at the end only, so it stays a name match rather than a substring
 * one: a name is matched where the title ends, never inside it. What it gives up
 * is that a longer title ending in the same words also matches, which runs more
 * tests than named — the direction selection is allowed to err in.
 *
 * Throws on an empty list, for the reason {@link testNamePattern} does.
 */
export function testNameSuffixPattern(names: readonly string[]): string {
  return `(?:${alternation(names)})$`;
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
