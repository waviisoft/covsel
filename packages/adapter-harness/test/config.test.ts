import { describe, expect, it } from 'vitest';

import { resolveHarnessConfig } from '../src/config.js';

describe('resolveHarnessConfig', () => {
  it('resolves a minimal, valid config', () => {
    const config = resolveHarnessConfig({
      run: '--only {id}',
      server: { observes: ['src/**'] },
    });
    expect(config.server.observes).toEqual(['src/**']);
    expect(config.server.inspectUrl).toBe('http://127.0.0.1:9229');
    expect(config.run.expand(['a'])).toEqual(['--only', 'a']);
    expect(config.boundary).toBeUndefined();
  });

  it('keeps an explicit inspectUrl', () => {
    const config = resolveHarnessConfig({
      run: '--only {id}',
      server: { observes: ['src/**'], inspectUrl: 'http://127.0.0.1:1234' },
    });
    expect(config.server.inspectUrl).toBe('http://127.0.0.1:1234');
  });

  it('carries a boundary config through, presence selecting the mode', () => {
    const config = resolveHarnessConfig({
      run: '--only {id}',
      server: { observes: ['src/**'] },
      boundary: { timeoutMs: 5000 },
    });
    expect(config.boundary).toEqual({ timeoutMs: 5000 });
  });

  it('accepts an empty boundary object as opting into the boundary protocol', () => {
    const config = resolveHarnessConfig({
      run: '--only {id}',
      server: { observes: ['src/**'] },
      boundary: {},
    });
    expect(config.boundary).toEqual({});
  });

  it('rejects a missing harness config', () => {
    expect(() => resolveHarnessConfig(undefined)).toThrow(/missing or not an object/);
  });

  it('rejects a missing run template', () => {
    expect(() => resolveHarnessConfig({ server: { observes: ['src/**'] } })).toThrow(
      /\.run is missing/,
    );
  });

  it('rejects a missing server section', () => {
    expect(() => resolveHarnessConfig({ run: '--only {id}' })).toThrow(/\.server is/);
  });

  it('rejects an empty observes list -- no default here is honest', () => {
    expect(() =>
      resolveHarnessConfig({ run: '--only {id}', server: { observes: [] } }),
    ).toThrow(/\.server\.observes is missing, empty/);
  });

  it('does not special-case ** -- covsel takes the project at its word', () => {
    expect(() =>
      resolveHarnessConfig({ run: '--only {id}', server: { observes: ['**'] } }),
    ).not.toThrow();
  });

  it('rejects a malformed boundary section', () => {
    expect(() =>
      resolveHarnessConfig({
        run: '--only {id}',
        server: { observes: ['src/**'] },
        boundary: { timeoutMs: 'soon' },
      }),
    ).toThrow(/\.boundary\.timeoutMs/);
  });

  it('carries server.settleMs through, unset by default', () => {
    const withoutSettle = resolveHarnessConfig({
      run: '--only {id}',
      server: { observes: ['src/**'] },
    });
    expect(withoutSettle.server.settleMs).toBeUndefined();

    const withSettle = resolveHarnessConfig({
      run: '--only {id}',
      server: { observes: ['src/**'], settleMs: 250 },
    });
    expect(withSettle.server.settleMs).toBe(250);
  });

  it('rejects a non-numeric server.settleMs', () => {
    expect(() =>
      resolveHarnessConfig({
        run: '--only {id}',
        server: { observes: ['src/**'], settleMs: 'soon' },
      }),
    ).toThrow(/\.server\.settleMs/);
  });

  it('carries a top-level testTimeoutMs through, for per-test mode', () => {
    const withoutTimeout = resolveHarnessConfig({
      run: '--only {id}',
      server: { observes: ['src/**'] },
    });
    expect(withoutTimeout.testTimeoutMs).toBeUndefined();

    const withTimeout = resolveHarnessConfig({
      run: '--only {id}',
      server: { observes: ['src/**'] },
      testTimeoutMs: 5000,
    });
    expect(withTimeout.testTimeoutMs).toBe(5000);
  });

  it('rejects a non-numeric top-level testTimeoutMs', () => {
    expect(() =>
      resolveHarnessConfig({
        run: '--only {id}',
        server: { observes: ['src/**'] },
        testTimeoutMs: 'soon',
      }),
    ).toThrow(/\.testTimeoutMs/);
  });
});
