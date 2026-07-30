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
 * Names are escaped so they match literally, and the alternation is anchored so
 * one name is not matched inside a longer title. Anchoring cannot skip a test:
 * a runner matching the pattern against a fuller title than the name recorded —
 * a leaf name inside a `describe` — simply runs more tests than named, which is
 * the direction selection is allowed to err in.
 *
 * Throws on an empty list. A pattern over no names matches nothing, so handing
 * one to a runner would report a green run that executed no test; callers with
 * nothing to name have nothing to run.
 */
export function testNamePattern(names: readonly string[]): string {
  if (names.length === 0) throw new Error('cannot build a pattern from no test names');
  const escaped = names.map((name) => name.replace(METACHARACTERS, '\\$&'));
  return `^(?:${escaped.join('|')})$`;
}
