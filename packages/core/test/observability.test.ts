import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commitAll, write } from './helpers/repo.js';
import {
  computeStatus,
  type CoverageMap,
  type CovselConfig,
  createGenericRecorder,
  FailOpenPolicy,
  fullRunReason,
  MAP_SCHEMA_VERSION,
  mergeMaps,
  OBSERVES_EVERYTHING,
  recordMap,
  type Recorder,
  resolveConfig,
  selectAffected,
  unobservedChange,
} from '../src/index.js';

/**
 * The guard for the one thing a partial recorder can get catastrophically
 * wrong: reading its own blind spot as "this code ran nowhere". A recorder that
 * watches only part of a test's execution records a map whose silence about
 * everything else is an artifact of where it was looking, and selecting on that
 * silence skips tests the change breaks.
 *
 * The fixture is deliberately shaped like the case that motivated it — sources
 * the recorder can see, plus code it cannot, exercised by no test file — so the
 * two situations are indistinguishable from the map alone and only the declared
 * scope tells them apart.
 */

const FILES: Record<string, string> = {
  'src/shared.mjs': `export function tag(s) {\n  return \`[covsel] \${s}\`;\n}\n`,
  'src/a.mjs': `import { tag } from './shared.mjs';\nexport function alpha(x) {\n  return tag(\`alpha:\${x * 2}\`);\n}\n`,
  'src/b.mjs': `import { tag } from './shared.mjs';\nexport function beta(x) {\n  return tag(\`beta:\${x + 1}\`);\n}\n`,
  // Stands in for code running somewhere the recorder cannot see — an app
  // server, another isolate. No test file names it, so the map is silent about
  // it either way.
  'server/logic.mjs': `export function price(qty) {\n  return qty * 3 + 1;\n}\n`,
  'test/a.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { alpha } from '../src/a.mjs';\ntest('alpha', () => assert.equal(alpha(2), '[covsel] alpha:4'));\n`,
  'test/b.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { beta } from '../src/b.mjs';\ntest('beta', () => assert.equal(beta(2), '[covsel] beta:3'));\n`,
  '.gitignore': `.covsel/\n`,
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Record the fixture with a recorder declaring `observes`. Sources are limited
 * to `src/**`, so `server/logic.mjs` is genuinely absent from the map and the
 * only thing separating the two runs is what the recorder claims it could see.
 */
async function recordFixture(observes: readonly string[]): Promise<{
  cwd: string;
  config: CovselConfig;
}> {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-observed-'));
  dirs.push(cwd);
  for (const [rel, content] of Object.entries(FILES)) write(cwd, rel, content);
  write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
  commitAll(cwd);

  const config = resolveConfig({ sourceGlobs: ['src/**'] });
  const base = createGenericRecorder({ command: ['node', '--test'], cwd, config });
  const recorder: Recorder = { observes, record: (f) => base.record(f) };
  const result = await recordMap({ cwd, config, recorder });
  expect(result.ok).toBe(true);
  return { cwd, config };
}

describe('a recording is held to what it could observe', () => {
  it('falls open when a change lands outside the observed scope', async () => {
    const { cwd, config } = await recordFixture(['src/**']);
    write(
      cwd,
      'server/logic.mjs',
      'export function price(qty) {\n  return qty * 4 + 1;\n}\n',
    );

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('server/logic.mjs');
    expect(result.tests).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  }, 60_000);

  it('still selects precisely for a change inside the observed scope', async () => {
    const { cwd, config } = await recordFixture(['src/**']);
    write(cwd, 'src/a.mjs', FILES['src/a.mjs']!.replace('x * 2', 'x * 3'));

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  }, 60_000);

  it('is what separates a blind spot from a measurement', async () => {
    // Same fixture, same edit, same absence from the map — the only difference
    // is the claim. A recorder that says it saw everything gets believed, which
    // is why the claim may never be inferred or defaulted.
    const { cwd, config } = await recordFixture(OBSERVES_EVERYTHING);
    write(
      cwd,
      'server/logic.mjs',
      'export function price(qty) {\n  return qty * 4 + 1;\n}\n',
    );

    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual([]);
  }, 60_000);

  it('reports the observed scope in status', async () => {
    const { cwd, config } = await recordFixture(['src/**']);
    const status = await computeStatus({ cwd, config });
    expect(status.observed).toEqual(['src/**']);

    write(
      cwd,
      'server/logic.mjs',
      'export function price(qty) {\n  return qty * 9;\n}\n',
    );
    const after = await computeStatus({ cwd, config });
    expect(after.nextIsFullRun).toBe(true);
    expect(after.nextFullRunReason).toContain('server/logic.mjs');
  }, 60_000);
});

describe('unobservedChange', () => {
  const map: CoverageMap = {
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity: 'file' as const,
    recordedAt: '2026-01-01T00:00:00.000Z',
    sentinelHashes: {},
    observed: ['src/**'],
    // One entry, so the scope is what these tests actually exercise: a map with
    // no entries measured nothing and forces a full run before scope is reached.
    entries: [
      {
        test: { file: 'test/a.test.mjs' },
        files: [{ file: 'src/a.ts', fileHash: 'sha256:a' }],
      },
    ],
  };
  const change = (file: string) => ({ file, kind: 'modified' as const });

  it('names the first change outside the scope', () => {
    expect(unobservedChange(map, [change('src/a.ts'), change('server/x.ts')])).toBe(
      'server/x.ts',
    );
  });

  it('is undefined when every change is inside the scope', () => {
    expect(unobservedChange(map, [change('src/a.ts')])).toBeUndefined();
  });

  it('treats an empty scope as observing nothing', () => {
    expect(unobservedChange({ ...map, observed: [] }, [change('src/a.ts')])).toBe(
      'src/a.ts',
    );
  });

  it('reads the globs strictly, so a narrow scope cannot widen itself', () => {
    // The shared matcher widens slash-less globs to match a basename anywhere,
    // which is right everywhere else: matching more sentinels or more test globs
    // runs more tests. Here it inverts — a path wrongly counted as observed
    // suppresses the full run it should have caused. `*.mjs` means top-level
    // only, and nothing nested may pass as covered by it.
    const narrow = { ...map, observed: ['*.mjs'] };
    expect(unobservedChange(narrow, [change('server/deep/logic.mjs')])).toBe(
      'server/deep/logic.mjs',
    );
    expect(unobservedChange(narrow, [change('top.mjs')])).toBeUndefined();
  });

  it('treats ** as observing every path, nested and dotted alike', () => {
    const everything = { ...map, observed: [...OBSERVES_EVERYTHING] };
    const paths = ['README.md', 'src/a.ts', 'a/b/c/d.ts', '.github/workflows/ci.yaml'];
    expect(unobservedChange(everything, paths.map(change))).toBeUndefined();
  });

  it('forces a full run through the policy, and says why', () => {
    const config = resolveConfig();
    const changes = [change('server/x.ts')];
    expect(new FailOpenPolicy(config).evaluate(map, changes)).toBe('full-run');
    expect(fullRunReason(config, map, changes)).toContain('server/x.ts');
  });
});

describe('mergeMaps and the observed scope', () => {
  const shard = (observed: string[]): CoverageMap => ({
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity: 'file' as const,
    commit: 'abc123',
    recordedAt: '2026-02-01T00:00:00.000Z',
    sentinelHashes: {},
    observed,
    entries: [],
  });

  it('keeps the scope when every shard agrees', () => {
    expect(mergeMaps([shard(['src/**']), shard(['src/**'])]).observed).toEqual([
      'src/**',
    ]);
  });

  it('ignores the order shards list their globs in', () => {
    const merged = mergeMaps([shard(['src/**', 'lib/**']), shard(['lib/**', 'src/**'])]);
    expect(merged.observed).toEqual(['src/**', 'lib/**']);
  });

  it('claims nothing when shards disagree, rather than unioning', () => {
    // Unioning would let one shard's coverage vouch for paths the other was
    // never watching. An empty scope puts every change outside it, so the
    // merged map falls open instead.
    const merged = mergeMaps([shard(['src/**']), shard(['server/**'])]);
    expect(merged.observed).toEqual([]);
    expect(unobservedChange(merged, [{ file: 'src/a.ts', kind: 'modified' }])).toBe(
      'src/a.ts',
    );
  });
});
