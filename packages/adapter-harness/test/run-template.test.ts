import { describe, expect, it } from 'vitest';

import { parseRunTemplate } from '../src/run-template.js';

describe('parseRunTemplate', () => {
  it('repeats the flag before {id} once per selected id', () => {
    const t = parseRunTemplate('--only {id}');
    expect(t.expand(['a', 'b'])).toEqual(['--only', 'a', '--only', 'b']);
  });

  it('expands {ids} to one comma-joined token', () => {
    const t = parseRunTemplate('--select {ids}');
    expect(t.expand(['a', 'b'])).toEqual(['--select', 'a,b']);
  });

  it('repeats a bare {id} with no preceding flag positionally', () => {
    const t = parseRunTemplate('{id}');
    expect(t.expand(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('keeps tokens before and after the repeated unit', () => {
    const t = parseRunTemplate('run --only {id} --verbose');
    expect(t.expand(['a', 'b'])).toEqual([
      'run',
      '--only',
      'a',
      '--only',
      'b',
      '--verbose',
    ]);
  });

  it('honors double-quoted tokens', () => {
    const t = parseRunTemplate('--only "{id}"');
    expect(t.expand(['a'])).toEqual(['--only', 'a']);
  });

  it('expands to no tokens at all for an empty selection', () => {
    expect(parseRunTemplate('--only {id}').expand([])).toEqual([]);
    expect(parseRunTemplate('--select {ids}').expand([])).toEqual([]);
  });

  it('refuses a template with no placeholder', () => {
    expect(() => parseRunTemplate('--only nothing')).toThrow(/names no test/);
  });

  it('refuses a template with both placeholders', () => {
    expect(() => parseRunTemplate('--only {id} --and {ids}')).toThrow(
      /more than one placeholder/,
    );
  });

  it('refuses a template with {id} twice', () => {
    expect(() => parseRunTemplate('--only {id} --also {id}')).toThrow(
      /more than one placeholder/,
    );
  });

  it('refuses to join ids under {ids} when one contains a comma -- it would be indistinguishable from separate ids', () => {
    const t = parseRunTemplate('--select {ids}');
    expect(() => t.expand(['a,b', 'c'])).toThrow(/comma/);
  });

  it('has no such limit under {id}, which repeats the flag instead of joining', () => {
    const t = parseRunTemplate('--only {id}');
    expect(t.expand(['a,b', 'c'])).toEqual(['--only', 'a,b', '--only', 'c']);
  });
});
