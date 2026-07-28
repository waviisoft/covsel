import { describe, expect, it } from 'vitest';

import { type Adapter, assertAdapter } from '../src/index.js';

/**
 * The contract's runtime gate. Everything here is a module covsel did not
 * compile -- the compiler cannot help, and a wrong answer is expensive: an
 * adapter accepted but unable to drive its runner records that its tests cover
 * nothing, which silently skips them on every diff after that.
 */

const conforming = {
  name: 'probe',
  formatSelection: (): string[] => [],
  createRecorder: () => ({ record: async () => [] }),
};

describe('assertAdapter', () => {
  it('accepts an adapter with only the required capabilities', () => {
    expect(() => assertAdapter(conforming, 'probe')).not.toThrow();
  });

  it('accepts the optional capabilities when they are the right shape', () => {
    expect(() =>
      assertAdapter(
        { ...conforming, runSelection: () => 0, defaultTestGlobs: ['**/*.feature'] },
        'probe',
      ),
    ).not.toThrow();
  });

  it.each([
    [
      'no name',
      {
        formatSelection: conforming.formatSelection,
        createRecorder: conforming.createRecorder,
      },
      /no name/,
    ],
    [
      'no formatSelection',
      { name: 'x', createRecorder: conforming.createRecorder },
      /no formatSelection/,
    ],
    ['no createRecorder', { name: 'x', formatSelection: () => [] }, /no createRecorder/],
    ['a name that is not a string', { ...conforming, name: 7 }, /name is number/],
    ['an empty name', { ...conforming, name: '' }, /name is empty/],
    [
      'a formatSelection that is not callable',
      { ...conforming, formatSelection: [] },
      /formatSelection is object/,
    ],
    [
      'a runSelection that is not callable',
      { ...conforming, runSelection: 'yes' },
      /runSelection is string/,
    ],
    [
      'globs that are not strings',
      { ...conforming, defaultTestGlobs: [1] },
      /not an array of strings/,
    ],
    [
      'globs that would find nothing',
      { ...conforming, defaultTestGlobs: [] },
      /no test would ever be discovered/,
    ],
  ])('rejects %s', (_label, value, expected) => {
    expect(() => assertAdapter(value, 'probe')).toThrow(expected);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'vitest'],
    ['a function', (): void => {}],
  ])('rejects %s', (_label, value) => {
    expect(() => assertAdapter(value, 'probe')).toThrow(/is not a covsel adapter/);
  });

  it('names the source it was given, so a failure says which package', () => {
    expect(() => assertAdapter({}, "'@acme/covsel-adapter'")).toThrow(
      /'@acme\/covsel-adapter' is not a covsel adapter/,
    );
  });

  it('narrows to Adapter for the caller', () => {
    const value: unknown = conforming;
    assertAdapter(value, 'probe');
    // Reached only if the assertion narrowed: this would not compile otherwise.
    const adapter: Adapter = value;
    expect(adapter.name).toBe('probe');
  });
});
