import type { CovselConfig } from './config.js';
import { makeMatcher, makeStrictMatcher } from './match.js';
import { isExcludedRel, walkFiles } from './paths.js';

/** Discover test files under `cwd`, sorted, excluding vendored/build dirs. */
export function discoverTestFiles(
  cwd: string,
  config: Pick<CovselConfig, 'testGlobs'>,
): string[] {
  const isTest = makeMatcher(config.testGlobs);
  return walkFiles(cwd)
    .filter((rel) => isTest(rel))
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
  // `sourceGlobs` strictly, `testGlobs` widened, and the asymmetry is the point.
  //
  // `makeMatcher` gives a slash-less glob a second chance against a path's
  // basename anywhere in the tree, which is right for a sentinel — matching more
  // of those runs more tests — and wrong here. `sourceGlobs: ['index.js']` means
  // the entry point, and under widening it silently meant *every* `index.js` in
  // the repository: on `expressjs/express` a map reporting 29 covered sources for
  // a library with 7, the other 22 being example apps that ship to nobody. That
  // is over-selection rather than a skipped test, but it makes the map useless as
  // a diagnostic and quietly erodes the saving covsel exists to deliver. Anyone
  // wanting the recursive reading writes `**/index.js`, which already works and
  // says so.
  //
  // `testGlobs` keeps the widening because there it inverts: a glob that
  // discovers fewer test files leaves the ones it missed unrun, and `*.test.js`
  // meaning "only at the root" would be a skipped test rather than a wide map.
  const isSource = makeStrictMatcher(config.sourceGlobs);
  const isTest = makeMatcher(config.testGlobs);
  return (rel: string): boolean => !isExcludedRel(rel) && !isTest(rel) && isSource(rel);
}
