import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type CoverageMap,
  type CovselConfig,
  createGenericRecorder,
  type RecordEvent,
  recordMap,
  type RecordResult,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * The guard for a map entry that exists and says nothing. A test whose bundle
 * cannot be resolved back to original sources records zero covered files, which
 * is indistinguishable from a test that genuinely covers nothing — and selection
 * reads it the second way. The entry exists, so the unmapped-test guard does not
 * fire, and editing the file every test executes selects nothing at all.
 *
 * Nothing downstream of recording can recover that difference — an entry that
 * credits nothing and a test that covers nothing are the same bytes — which is
 * why the failure belongs at record time and these tests assert on recording.
 *
 * The fixture is the shape a default `vite build` leaves behind: tests that
 * exercise their sources only through a bundle, with the build's source maps
 * either absent (source maps are opt-in), present as a sidecar, inlined, or
 * emitted without the comment that points at them (`sourcemap: 'hidden'`).
 */

/** The unbundled sources. Nothing imports them once the bundle exists. */
const SOURCES: Record<string, string> = {
  'src/shared.mjs': `export function tag(s) {\n  return \`[covsel] \${s}\`;\n}\n`,
  'src/a.mjs': `import { tag } from './shared.mjs';\nexport function alpha(x) {\n  return tag(\`alpha:\${x * 2}\`);\n}\n`,
  'src/b.mjs': `import { tag } from './shared.mjs';\nexport function beta(x) {\n  return tag(\`beta:\${x + 1}\`);\n}\n`,
};

/** What the bundler emitted: all three sources flattened into one script. */
const BUNDLE = `function tag(s) {
  return \`[covsel] \${s}\`;
}
function alpha(x) {
  return tag(\`alpha:\${x * 2}\`);
}
function beta(x) {
  return tag(\`beta:\${x + 1}\`);
}
export { alpha, beta };
`;

const TESTS: Record<string, string> = {
  'test/a.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { alpha } from '../dist/bundle.mjs';\ntest('alpha', () => assert.equal(alpha(2), '[covsel] alpha:4'));\n`,
  'test/b.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { beta } from '../dist/bundle.mjs';\ntest('beta', () => assert.equal(beta(2), '[covsel] beta:3'));\n`,
};

/**
 * A source map for the bundle. Only `sources` is read at file granularity: a
 * mapped script credits every original source it was built from, until range
 * projection can narrow that to the regions that actually executed.
 */
function bundleMap(sources: string[]): string {
  return JSON.stringify({
    version: 3,
    file: 'bundle.mjs',
    sources,
    sourcesContent: sources.map(() => null),
    names: [],
    mappings: '',
  });
}

const IN_REPO_SOURCES = ['../src/shared.mjs', '../src/a.mjs', '../src/b.mjs'];

/** How the build published its source map, if at all. */
type MapStyle = 'none' | 'sidecar' | 'inline' | 'hidden' | 'foreign';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function write(cwd: string, rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** Lay down the fixture repo, built the way `style` says, and commit it. */
function buildFixture(style: MapStyle, extra: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-unmappable-'));
  dirs.push(cwd);
  for (const [rel, content] of Object.entries({ ...SOURCES, ...TESTS, ...extra })) {
    write(cwd, rel, content);
  }
  write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
  write(cwd, '.gitignore', '.covsel/\n');

  const sidecar = bundleMap(
    style === 'foreign' ? ['/elsewhere/src/gone.mjs'] : IN_REPO_SOURCES,
  );
  if (style === 'sidecar' || style === 'hidden' || style === 'foreign') {
    write(cwd, 'dist/bundle.mjs.map', sidecar);
  }
  const comment =
    style === 'sidecar' || style === 'foreign'
      ? '//# sourceMappingURL=bundle.mjs.map\n'
      : style === 'inline'
        ? `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(sidecar).toString('base64')}\n`
        : '';
  write(cwd, 'dist/bundle.mjs', BUNDLE + comment);

  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'covsel test']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'fixture']);
  return cwd;
}

async function record(
  cwd: string,
  config: CovselConfig,
): Promise<{ result: RecordResult; events: RecordEvent[] }> {
  const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
  const events: RecordEvent[] = [];
  const result = await recordMap({
    cwd,
    config,
    recorder,
    onEvent: (e) => events.push(e),
  });
  return { result, events };
}

/** The source files one recorded entry credits, sorted. */
function coveredBy(map: CoverageMap, file: string): string[] {
  const entry = map.entries.find((e) => e.test.file === file);
  return (entry?.files ?? []).map((f) => f.file).sort();
}

describe('an executed script that cannot be mapped is a recording failure', () => {
  it('fails the recording when the bundle carries no source map', async () => {
    const cwd = buildFixture('none');
    const config = resolveConfig();
    const { result, events } = await record(cwd, config);

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.file)).toEqual([
      'test/a.test.mjs',
      'test/b.test.mjs',
    ]);
    for (const failure of result.failures) {
      expect(failure.reason).toContain('dist/bundle.mjs');
    }
    expect(events.every((e) => e.kind === 'failed')).toBe(true);
    expect(existsSync(join(cwd, '.covsel', 'map.json'))).toBe(false);
  }, 60_000);

  it('leaves the next selection a full run rather than an empty one', async () => {
    // The failure is only worth having because of what it prevents downstream:
    // with no map on disk, editing the file every test executes runs everything.
    const cwd = buildFixture('none');
    const config = resolveConfig();
    await record(cwd, config);
    write(cwd, 'src/shared.mjs', 'export function tag(s) {\n  return `[x] ${s}`;\n}\n');

    const selection = await selectAffected({ cwd, config });
    expect(selection.fullRun).toBe(true);
    expect(selection.tests).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  }, 60_000);

  it('fails when the source map resolves to no source in the repository', async () => {
    const cwd = buildFixture('foreign');
    const { result } = await record(cwd, resolveConfig());

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toContain('dist/bundle.mjs');
    expect(existsSync(join(cwd, '.covsel', 'map.json'))).toBe(false);
  }, 60_000);
});

describe('a source map the build did publish is resolved', () => {
  for (const style of ['sidecar', 'inline', 'hidden'] as const) {
    it(`records the bundle's original sources from a ${style} map`, async () => {
      const cwd = buildFixture(style);
      const config = resolveConfig();
      const { result } = await record(cwd, config);

      expect(result.ok).toBe(true);
      // Every source the bundle was built from, not only the ones this test
      // reached: narrowing that to the executed ranges is the projection work,
      // and crediting too much over-selects, which is the safe direction.
      expect(coveredBy(result.map!, 'test/a.test.mjs')).toEqual([
        'src/a.mjs',
        'src/b.mjs',
        'src/shared.mjs',
      ]);

      write(cwd, 'src/shared.mjs', 'export function tag(s) {\n  return `[x] ${s}`;\n}\n');
      const selection = await selectAffected({ cwd, config });
      expect(selection.fullRun).toBe(false);
      expect(selection.tests).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
    }, 60_000);
  }
});

describe('what the recording still credits', () => {
  it('records a source that executed directly, stray sidecar map or not', async () => {
    // The guard against this change ever crediting less than it used to: a file
    // the runner executed from the repository is its own source, and a source
    // map beside it that leads nowhere may not take that away.
    const cwd = buildFixture('sidecar', {
      'src/direct.mjs': `export function direct() {\n  return 'direct';\n}\n//# sourceMappingURL=direct.mjs.map\n`,
      'src/direct.mjs.map': JSON.stringify({
        version: 3,
        file: 'direct.mjs',
        sources: ['./gone.ts'],
        names: [],
        mappings: '',
      }),
      'test/direct.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { direct } from '../src/direct.mjs';\ntest('direct', () => assert.equal(direct(), 'direct'));\n`,
    });
    const { result } = await record(cwd, resolveConfig());

    expect(result.ok).toBe(true);
    expect(coveredBy(result.map!, 'test/direct.test.mjs')).toEqual(['src/direct.mjs']);
  }, 60_000);
});

describe('a script that is legitimately outside the source globs', () => {
  const PKG: Record<string, string> = {
    'node_modules/dep/package.json': '{\n  "name": "dep",\n  "type": "module"\n}\n',
    'test/dep.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { dep } from '../node_modules/dep/index.mjs';\ntest('dep', () => assert.equal(dep(), 'dep'));\n`,
  };
  const DEP = `export function dep() {\n  return 'dep';\n}\n`;

  it('is not a failure when the dependency ships a source map', async () => {
    const cwd = buildFixture('sidecar', {
      ...PKG,
      'node_modules/dep/index.mjs': `${DEP}//# sourceMappingURL=index.mjs.map\n`,
      'node_modules/dep/index.mjs.map': JSON.stringify({
        version: 3,
        file: 'index.mjs',
        sources: ['./src/index.ts'],
        names: [],
        mappings: '',
      }),
      'node_modules/dep/src/index.ts': DEP,
    });
    const { result } = await record(cwd, resolveConfig());

    expect(result.ok).toBe(true);
    expect(coveredBy(result.map!, 'test/dep.test.mjs')).toEqual([]);
  }, 60_000);

  it('is not a failure when the dependency ships none either', async () => {
    // Vendored code is outside what a recording maps by design — a dependency
    // change is caught by the lockfile sentinel, not by coverage — so a
    // dependency with no source map is not the hole this rule closes.
    const cwd = buildFixture('sidecar', { ...PKG, 'node_modules/dep/index.mjs': DEP });
    const { result } = await record(cwd, resolveConfig());

    expect(result.ok).toBe(true);
    expect(coveredBy(result.map!, 'test/dep.test.mjs')).toEqual([]);
  }, 60_000);
});

describe('unmappable scripts a project has accepted', () => {
  it('records instead of failing, and says which scripts it let through', async () => {
    const cwd = buildFixture('none');
    const config = resolveConfig({
      sourceMaps: { allowUnmappable: ['dist/**'] },
    });
    const { result, events } = await record(cwd, config);

    expect(result.ok).toBe(true);
    expect(coveredBy(result.map!, 'test/a.test.mjs')).toEqual([]);
    // Loud, or it is the same silent hole somewhere else.
    const recorded = events.filter((e) => e.kind === 'recorded');
    expect(recorded).toHaveLength(2);
    for (const event of recorded) {
      expect(event.allowedUnmappable).toEqual(['dist/bundle.mjs']);
    }
  }, 60_000);
});
