import picomatch from 'picomatch';

/**
 * Build a path matcher from a set of globs. Slash-less patterns (e.g.
 * `package.json`, `tsconfig*.json`) additionally match against a path's
 * basename anywhere in the tree, so a sentinel like `package.json` catches a
 * nested `packages/core/package.json` too. Over-matching here only ever widens
 * selection, which is the safe direction.
 */
export function makeMatcher(patterns: readonly string[]): (rel: string) => boolean {
  if (patterns.length === 0) return () => false;
  const full = picomatch(patterns as string[], { dot: true });
  const slashless = patterns.filter((p) => !p.includes('/'));
  const byBasename = slashless.length
    ? picomatch(slashless as string[], { dot: true })
    : undefined;
  return (rel: string): boolean => {
    if (full(rel)) return true;
    if (byBasename) {
      const slash = rel.lastIndexOf('/');
      const base = slash === -1 ? rel : rel.slice(slash + 1);
      if (byBasename(base)) return true;
    }
    return false;
  };
}

/**
 * Build a path matcher that means exactly what its globs say — no basename
 * widening.
 *
 * {@link makeMatcher} widens on purpose, because for sentinels, test globs, and
 * always-run globs a wider match runs more tests. That polarity inverts for a
 * glob set describing what a recording could observe: there, matching a path it
 * does not really cover suppresses the full run that path was supposed to
 * trigger. Widening would skip tests, so this matcher does not.
 */
export function makeStrictMatcher(patterns: readonly string[]): (rel: string) => boolean {
  if (patterns.length === 0) return () => false;
  return picomatch(patterns as string[], { dot: true });
}

/** Convenience: does `rel` match any of `patterns`? */
export function matchesAny(rel: string, patterns: readonly string[]): boolean {
  return makeMatcher(patterns)(rel);
}
