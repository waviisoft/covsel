import type { CovselConfig } from './config.js';
import { makeMatcher, makeStrictMatcher } from './match.js';
import { isExcludedRel, walkFiles } from './paths.js';

/**
 * Discover test files under `cwd`, sorted, excluding vendored/build dirs and
 * anything the project declared its runner will not run.
 *
 * `testIgnore` subtracts rather than narrowing, because a glob set cannot say
 * "every test except this one". Applied here and only here: a file the runner
 * never runs must not be discovered, recorded, or selected, but it is still a
 * test file everywhere that asks what a path *is* -- so it stays out of the
 * sources a recording may credit.
 *
 * Matched strictly, unlike every other glob set here. {@link makeMatcher} widens
 * a slash-less pattern to the basename anywhere in the tree, which is safe
 * wherever a match runs *more* tests -- and this is the one set where a match
 * runs fewer. Widened, `testIgnore: ['conformance.test.ts']` would remove the
 * conformance suite of every adapter in the repository rather than the one file
 * the project meant, and the tests only those files covered would be selected by
 * nothing thereafter. Same inversion, same answer as `observes`.
 */
export function discoverTestFiles(
  cwd: string,
  config: Pick<CovselConfig, 'testGlobs'> & Partial<Pick<CovselConfig, 'testIgnore'>>,
): string[] {
  const isTest = makeMatcher(config.testGlobs);
  const isIgnored = makeStrictMatcher(config.testIgnore ?? []);
  return walkFiles(cwd)
    .filter((rel) => isTest(rel) && !isIgnored(rel))
    .sort();
}

/**
 * Test files `testIgnore` removed from discovery, so a caller can report the
 * claim rather than let it work silently. A file counted here runs in neither
 * the recording nor any selection.
 */
export function ignoredTestFiles(
  cwd: string,
  config: Pick<CovselConfig, 'testGlobs'> & Partial<Pick<CovselConfig, 'testIgnore'>>,
): string[] {
  const ignored = config.testIgnore ?? [];
  if (ignored.length === 0) return [];
  const isTest = makeMatcher(config.testGlobs);
  const isIgnored = makeStrictMatcher(ignored);
  return walkFiles(cwd)
    .filter((rel) => isTest(rel) && isIgnored(rel))
    .sort();
}

/** True when a repo-relative path is a test file. */
export function isTestFile(
  rel: string,
  config: Pick<CovselConfig, 'testGlobs'>,
): boolean {
  return makeMatcher(config.testGlobs)(rel);
}

/**
 * Predicate for "this covered path is a source file we should record": under
 * the repo, not vendored/built, not itself a test. Shared by every observation
 * path so the generic and per-runner recorders agree on what counts as source.
 */
export function makeSourceFilter(
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs'>,
): (rel: string) => boolean {
  const isSource = makeMatcher(config.sourceGlobs);
  const isTest = makeMatcher(config.testGlobs);
  return (rel: string): boolean => !isExcludedRel(rel) && !isTest(rel) && isSource(rel);
}
