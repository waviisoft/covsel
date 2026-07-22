import type { CovselConfig } from './config.js';
import { makeMatcher } from './match.js';
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
  const isSource = makeMatcher(config.sourceGlobs);
  const isTest = makeMatcher(config.testGlobs);
  return (rel: string): boolean => !isExcludedRel(rel) && !isTest(rel) && isSource(rel);
}
