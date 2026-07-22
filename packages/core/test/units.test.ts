import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type CoverageMap,
  DEFAULT_CONFIG,
  FailOpenPolicy,
  fullRunReason,
  isExcludedRel,
  LocalStore,
  loadConfig,
  makeMatcher,
  makeSourceFilter,
  matchesAny,
  resolveConfig,
  toRepoRelative,
} from '../src/index.js';

const emptyMap: CoverageMap = {
  schemaVersion: 1,
  granularity: 'file',
  recordedAt: '',
  sentinelHashes: {},
  entries: [],
};

describe('config', () => {
  it('resolves to defaults when nothing is supplied', () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('overrides arrays and merges store', () => {
    const c = resolveConfig({ alwaysRun: ['x/**'], store: { dir: 'out' } });
    expect(c.alwaysRun).toEqual(['x/**']);
    expect(c.store.dir).toBe('out');
    expect(c.sentinels).toEqual(DEFAULT_CONFIG.sentinels);
  });

  it('loads .covsel.json over defaults', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'covsel-cfg-'));
    try {
      writeFileSync(join(dir, '.covsel.json'), JSON.stringify({ alwaysRun: ['e2e/**'] }));
      const c = await loadConfig(dir);
      expect(c.alwaysRun).toEqual(['e2e/**']);
      expect(c.testGlobs).toEqual(DEFAULT_CONFIG.testGlobs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('matching', () => {
  it('matches nested basenames for slash-less patterns', () => {
    const m = makeMatcher(['package.json', 'tsconfig*.json']);
    expect(m('package.json')).toBe(true);
    expect(m('packages/core/package.json')).toBe(true);
    expect(m('packages/core/tsconfig.build.json')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });

  it('empty pattern list matches nothing', () => {
    expect(matchesAny('anything', [])).toBe(false);
  });

  it('default test glob matches the usual extensions but not sources', () => {
    const isTest = makeMatcher(DEFAULT_CONFIG.testGlobs);
    for (const f of ['a.test.ts', 'x/b.spec.tsx', 'y/c.test.mjs', 'd.test.cjs']) {
      expect(isTest(f)).toBe(true);
    }
    expect(isTest('src/a.ts')).toBe(false);
  });

  it('source filter excludes vendored dirs and test files', () => {
    const isSource = makeSourceFilter(DEFAULT_CONFIG);
    expect(isSource('src/a.ts')).toBe(true);
    expect(isSource('node_modules/x/index.js')).toBe(false);
    expect(isSource('dist/a.js')).toBe(false);
    expect(isSource('test/a.test.ts')).toBe(false);
  });
});

describe('paths', () => {
  it('flags excluded segments at any depth', () => {
    expect(isExcludedRel('a/node_modules/b.js')).toBe(true);
    expect(isExcludedRel('.covsel/map.json')).toBe(true);
    expect(isExcludedRel('src/a.ts')).toBe(false);
  });

  it('returns undefined for paths outside the root', () => {
    expect(toRepoRelative('/repo', '/elsewhere/a.ts')).toBeUndefined();
    expect(toRepoRelative('/repo', '/repo/src/a.ts')).toBe('src/a.ts');
  });
});

describe('policy', () => {
  const policy = new FailOpenPolicy(DEFAULT_CONFIG);

  it('full-run on an unusable map', () => {
    expect(policy.evaluate(undefined, [])).toBe('full-run');
  });

  it('full-run when a sentinel changes', () => {
    expect(policy.evaluate(emptyMap, [{ file: 'package.json', kind: 'modified' }])).toBe(
      'full-run',
    );
    expect(policy.evaluate(emptyMap, [{ file: 'src/a.ts', kind: 'modified' }])).toBe(
      'select',
    );
  });

  it('mandatory includes added/modified test files only', async () => {
    const tests = await policy.mandatory([
      { file: 'test/new.test.ts', kind: 'added' },
      { file: 'test/changed.test.ts', kind: 'modified' },
      { file: 'test/gone.test.ts', kind: 'deleted' },
      { file: 'src/a.ts', kind: 'modified' },
    ]);
    expect(tests.map((t) => t.file)).toEqual([
      'test/new.test.ts',
      'test/changed.test.ts',
    ]);
  });

  it('explains the full-run reason', () => {
    expect(fullRunReason(DEFAULT_CONFIG, undefined, [])).toContain('no usable map');
    expect(
      fullRunReason(DEFAULT_CONFIG, emptyMap, [
        { file: 'package.json', kind: 'modified' },
      ]),
    ).toContain('sentinel changed');
  });
});

describe('store', () => {
  it('round-trips a map and rejects a stale schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'covsel-store-'));
    try {
      const store = new LocalStore({ cwd: dir, dir: '.covsel' });
      await store.write({
        schemaVersion: 1,
        granularity: 'file',
        recordedAt: '2026-01-01T00:00:00.000Z',
        sentinelHashes: {},
        entries: [],
      });
      expect(await store.read()).toBeDefined();

      writeFileSync(store.path(), JSON.stringify({ schemaVersion: 0, entries: [] }));
      expect(await store.read()).toBeUndefined();

      writeFileSync(store.path(), 'not json');
      expect(await store.read()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
