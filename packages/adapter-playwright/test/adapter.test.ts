import { describe, expect, it } from 'vitest';

import { assertAdapter, resolveConfig } from '@covsel/core';

import { PLAYWRIGHT_TEST_GLOBS, playwrightAdapter } from '../src/index.js';

describe('playwright adapter', () => {
  it('identifies itself as "playwright"', () => {
    expect(playwrightAdapter.name).toBe('playwright');
  });

  it('satisfies the adapter contract core checks at load time', () => {
    expect(() => assertAdapter(playwrightAdapter, 'test')).not.toThrow();
  });

  it('formats a selection as a deduplicated spec-file list', () => {
    const out = playwrightAdapter.formatSelection([
      { file: 'e2e/cart.spec.ts', name: 'cart.spec.ts adds an item' },
      { file: 'e2e/cart.spec.ts', name: 'cart.spec.ts empties the cart' },
      { file: 'e2e/admin.spec.ts' },
    ]);
    expect(out).toEqual(['e2e/cart.spec.ts', 'e2e/admin.spec.ts']);
  });

  it("discovers specs by Playwright's own default testMatch", () => {
    expect(PLAYWRIGHT_TEST_GLOBS).toEqual(['**/*.@(spec|test).?(c|m)[jt]s?(x)']);
  });
});

describe('the scope a Playwright recording claims', () => {
  const build = (observes?: string[]) =>
    playwrightAdapter.createRecorder({
      command: ['playwright', 'test'],
      cwd: '/nowhere',
      config: resolveConfig(observes === undefined ? {} : { observes }),
    });

  it('refuses to record until the project declares one', () => {
    // Neither default is available. `**` claims the browser watched the server
    // and the build scripts, so a change to either would read as touching code
    // no test covers and skip every test; nothing at all makes every recording
    // fall open on everything, which is a full run wearing selection's clothes.
    expect(() => build()).toThrow(/observes/);
  });

  it('refuses an empty declaration as loudly as a missing one', () => {
    expect(() => build([])).toThrow(/observes/);
  });

  it('declares exactly what the project wrote, and no wider glob covering it', () => {
    // Read as written, because a scope is a claim about recall: widening
    // `src/client/**` to `src/**` would suppress the full runs a change under
    // `src/server/**` is supposed to cause.
    expect([...build(['src/client/**']).observes]).toEqual(['src/client/**']);
  });

  it('records the whole run rather than one spec file at a time', () => {
    // A Playwright invocation pays for a browser launch and usually an
    // application boot, so per-file recording is not a slower version of the
    // same thing — it is a recording nobody runs twice.
    const recorder = build(['src/**']);
    expect(typeof recorder.recordRun).toBe('function');
    expect(recorder.record).toBeUndefined();
  });

  it('does not claim to see which packages a test ran code in', () => {
    // The browser executes a build, and a bundler that inlined a dependency
    // leaves nothing under `node_modules` running at all. Claiming otherwise
    // would credit a test with a package list missing whatever was fused in.
    expect(build(['src/**']).observesPackages).toBeUndefined();
  });
});
