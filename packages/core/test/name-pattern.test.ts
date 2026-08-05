import { describe, expect, it } from 'vitest';

import { testNamePattern, testNameSuffixPattern } from '@covsel/core';

/**
 * Every runner that can narrow a run below the file takes one regex over test
 * names — node:test's `--test-name-pattern`, cucumber's `--name`, Mocha's
 * `--grep` — so the pattern behind all three is built here. What it has to get
 * right is fail-open: a pattern that matches fewer tests than it names is a
 * selection that silently skips them.
 */
describe('testNamePattern', () => {
  const matches = (names: string[], title: string): boolean =>
    new RegExp(testNamePattern(names)).test(title);

  it('matches every name it was built from', () => {
    expect(matches(['alpha test'], 'alpha test')).toBe(true);
    expect(matches(['alpha test', 'beta test'], 'beta test')).toBe(true);
  });

  it('matches a name containing regex metacharacters literally', () => {
    const name = 'handles a+b (finally) [ok] $1 ^start .* {2}|or\\';
    expect(matches([name], name)).toBe(true);
  });

  it('does not let a metacharacter name silently match nothing', () => {
    // The failure this guards is the quiet one: an unescaped `a+b` compiles to a
    // valid regex that no title matches, so the run passes having executed no
    // affected test at all.
    expect(matches(['a+b'], 'a+b')).toBe(true);
    expect(matches(['a+b'], 'aab')).toBe(false);
  });

  it('anchors, so a name is not matched as part of a longer title', () => {
    expect(matches(['alpha'], 'alpha extended')).toBe(false);
    expect(matches(['alpha'], 'the alpha')).toBe(false);
  });

  it('keeps each alternative anchored when several names are combined', () => {
    const names = ['one', 'two'];
    expect(matches(names, 'one')).toBe(true);
    expect(matches(names, 'two')).toBe(true);
    expect(matches(names, 'one two')).toBe(false);
    expect(matches(names, 'three')).toBe(false);
  });

  it('refuses to build a pattern from no names', () => {
    // A pattern over an empty list matches nothing, and handing a runner a
    // filter that selects no test is the one outcome selection may never
    // produce quietly. Callers with nothing to name run nothing instead.
    expect(() => testNamePattern([])).toThrow(/no test names/);
  });
});

/**
 * The same pattern for a runner that matches it against a title it has prefixed
 * itself. Playwright greps against `<project> <file> <describes> <title>`, and
 * the project is the part a recorded name may not carry: a map recorded on
 * Chromium that named it would select nothing at all when the suite runs on
 * Firefox.
 */
describe('testNameSuffixPattern', () => {
  const matches = (names: string[], title: string): boolean =>
    new RegExp(testNameSuffixPattern(names)).test(title);

  it('matches a name the runner prefixed with something else', () => {
    expect(
      matches(['cart.spec.ts adds an item'], 'chromium cart.spec.ts adds an item'),
    ).toBe(true);
    // The same recorded name under a different project, which is the case a
    // front-anchored pattern gets wrong by matching nothing.
    expect(
      matches(['cart.spec.ts adds an item'], 'firefox cart.spec.ts adds an item'),
    ).toBe(true);
  });

  it('escapes metacharacters, so a spec filename matches literally', () => {
    // `.` is the one that bites here: every recorded Playwright name contains a
    // file extension, and unescaped `cart.spec.ts` would also match `cartxspecxts`
    // — over-matching, so safe — while an unescaped `a+b` in a title matches
    // nothing, which is not.
    expect(matches(['a+b'], 'chromium a+b')).toBe(true);
    expect(matches(['a+b'], 'chromium aab')).toBe(false);
  });

  it('anchors at the end, so a name is not matched in the middle of a title', () => {
    expect(matches(['adds an item'], 'chromium adds an item then removes it')).toBe(
      false,
    );
  });

  it('matches every name when several are combined', () => {
    const names = ['spec.ts one', 'spec.ts two'];
    expect(matches(names, 'chromium spec.ts one')).toBe(true);
    expect(matches(names, 'chromium spec.ts two')).toBe(true);
    expect(matches(names, 'chromium spec.ts three')).toBe(false);
  });

  it('refuses to build a pattern from no names', () => {
    expect(() => testNameSuffixPattern([])).toThrow(/no test names/);
  });
});
