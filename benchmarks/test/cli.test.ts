import { describe, expect, it } from 'vitest';

import { flag, flags, positiveNumber } from '../src/cli.js';

describe('flags', () => {
  it('collects every occurrence, in order', () => {
    expect(flags(['--head', 'a', '--head', 'b'], 'head')).toEqual(['a', 'b']);
  });

  it('is empty when the option was not given', () => {
    expect(flags(['--project', 'p.json'], 'head')).toEqual([]);
    expect(flag(['--project', 'p.json'], 'head')).toBeUndefined();
  });

  // Swallowing the next option would replay a commit called "--repetitions" and
  // silently drop the option the user did pass.
  it('refuses to take a following option as its value', () => {
    expect(() => flags(['--head', '--repetitions', '3'], 'head')).toThrow(
      '--head needs a value',
    );
  });

  it('refuses a trailing option with nothing after it', () => {
    expect(() => flags(['--project'], 'project')).toThrow('--project needs a value');
  });
});

describe('positiveNumber', () => {
  it('reads a value', () => {
    expect(positiveNumber(['--repetitions', '3'], 'repetitions', 1)).toBe(3);
  });

  it('falls back when the option is absent', () => {
    expect(positiveNumber([], 'repetitions', 1)).toBe(1);
  });

  // NaN would run each timed command zero times and report a wall-clock of
  // nothing, which reads as an extraordinary result rather than a typo.
  it.each(['x', '0', '-2', ''])('refuses %j', (raw) => {
    expect(() => positiveNumber(['--repetitions', raw], 'repetitions', 1)).toThrow(
      'positive number',
    );
  });
});
