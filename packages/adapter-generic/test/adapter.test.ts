import { resolveConfig } from '@covsel/core';
import { describe, expect, it } from 'vitest';
import { genericAdapter } from '../src/index.js';

describe('generic adapter', () => {
  it('vouches for no command, so its recorder claims no package observation', () => {
    // The adapter that wraps whatever it is handed is the one that cannot know
    // where the run executes its code. A recorder declaring `observesPackages`
    // has its entries paired with an inventory of what was installed, and a
    // package in that inventory which no entry credits reads as "installed and
    // never ran" -- so a browser-only dependency moving would select nothing.
    // The in-process-looking names are here on purpose. The tempting wrong fix
    // is an allowlist of runner binaries, and a probe that only ever passes
    // commands nobody would allowlist would certify one.
    const config = resolveConfig({});

    for (const command of [
      ['node', '--test'],
      ['npx', 'playwright', 'test'],
      ['npx', 'vitest', 'run'],
      ['pnpm', 'jest'],
      ['mocha', '--recursive'],
    ]) {
      const recorder = genericAdapter.createRecorder({
        command,
        cwd: process.cwd(),
        config,
      });
      expect(recorder.observesPackages).toBeUndefined();
    }
  });

  it('identifies itself as "generic"', () => {
    expect(genericAdapter.name).toBe('generic');
  });

  it('emits a deduplicated file list', () => {
    const out = genericAdapter.formatSelection([
      { file: 'a.test.ts', name: 'one' },
      { file: 'a.test.ts', name: 'two' },
      { file: 'b.test.ts' },
    ]);
    expect(out).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('returns an empty list for no tests', () => {
    expect(genericAdapter.formatSelection([])).toEqual([]);
  });

  it('preserves first-seen file order', () => {
    const out = genericAdapter.formatSelection([
      { file: 'z.test.ts' },
      { file: 'a.test.ts' },
      { file: 'z.test.ts', name: 'again' },
      { file: 'm.test.ts' },
    ]);
    expect(out).toEqual(['z.test.ts', 'a.test.ts', 'm.test.ts']);
  });

  it('collapses file-only and per-test ids of the same file to one entry', () => {
    const out = genericAdapter.formatSelection([
      { file: 'a.test.ts' },
      { file: 'a.test.ts', name: 'scenario 1' },
    ]);
    expect(out).toEqual(['a.test.ts']);
  });
});
