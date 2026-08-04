import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commitAll, write } from './helpers/repo.js';
import {
  combineObservations,
  type CoverageMap,
  type CovselConfig,
  createGenericRecorder,
  MAP_SCHEMA_VERSION,
  mergeMaps,
  OBSERVES_EVERYTHING,
  recordMap,
  type Recorder,
  type RecordedUnit,
  resolveConfig,
} from '../src/index.js';

/**
 * What a recording has to know before a dependency bump can select anything:
 * which packages each test executed, and what was installed at the time.
 *
 * Nothing here selects. Both halves are recorded and neither is read yet, so a
 * lockfile change is still answered by the sentinel list, exactly as it is today
 * — which is the point of landing them separately from the selection that will
 * use them.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A vendored package, installed the way a flat `node_modules` holds one. */
function installPackage(cwd: string, name: string, version: string, body: string): void {
  write(
    cwd,
    `node_modules/${name}/package.json`,
    `${JSON.stringify({ name, version, main: 'index.js', type: 'module' })}\n`,
  );
  write(cwd, `node_modules/${name}/index.js`, body);
}

/**
 * A repository whose two tests lean on different dependencies, so an entry
 * crediting the wrong one is visible rather than merely plausible.
 */
function fixture({ marker = true }: { marker?: boolean } = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-pkgrec-'));
  dirs.push(cwd);
  write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
  write(cwd, '.gitignore', '.covsel/\nnode_modules/\n');
  installPackage(cwd, 'left-pad', '1.3.0', 'export const pad = (s) => ` ${s}`;\n');
  installPackage(cwd, 'right-pad', '2.0.0', 'export const pad = (s) => `${s} `;\n');
  write(
    cwd,
    'src/a.mjs',
    "import { pad } from 'left-pad';\nexport const a = () => pad('a');\n",
  );
  write(cwd, 'src/b.mjs', 'export const b = () => `b`;\n');
  write(
    cwd,
    'test/a.test.mjs',
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { a } from '../src/a.mjs';\ntest('a', () => assert.equal(a(), ' a'));\n",
  );
  write(
    cwd,
    'test/b.test.mjs',
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { b } from '../src/b.mjs';\ntest('b', () => assert.equal(b(), 'b'));\n",
  );
  if (marker) write(cwd, 'node_modules/.pnpm/lock.yaml', 'lockfileVersion: 9.0\n');
  commitAll(cwd);
  return cwd;
}

/**
 * The generic recorder, told what it is running.
 *
 * `node --test` executes the whole fixture inside the process tree covsel
 * spawns, and these tests are the caller that knows it, having written the
 * command themselves. The recorder makes no package claim of its own, so
 * without the assertion there would be no package recording here to test.
 */
function vouchedRecorder(cwd: string, config: CovselConfig): Recorder {
  return createGenericRecorder({
    command: ['node', '--test'],
    cwd,
    config,
    runsInNodeProcessTree: true,
  });
}

/** Record the fixture with the generic recorder, or a stand-in for it. */
async function record(cwd: string, recorder?: Recorder): Promise<CoverageMap> {
  const config = resolveConfig({ sourceGlobs: ['src/**'] });
  const result = await recordMap({
    cwd,
    config,
    recorder: recorder ?? vouchedRecorder(cwd, config),
  });
  expect(result.failures).toEqual([]);
  return result.map!;
}

/** The packages one test's entry credits. */
function packagesOf(map: CoverageMap, file: string): string[] | undefined {
  return map.entries.find((e) => e.test.file === file)?.packages;
}

describe('recording which packages a test ran', () => {
  it('credits a dependency to the test that executed it, and not the other', async () => {
    const map = await record(fixture());

    expect(packagesOf(map, 'test/a.test.mjs')).toContain('left-pad');
    expect(packagesOf(map, 'test/b.test.mjs')).not.toContain('left-pad');
  }, 120_000);

  it('records an empty list rather than nothing for a test that ran no dependency', async () => {
    // The difference between the two is the whole feature: `[]` is a
    // measurement -- this test executed no vendored code -- while absence means
    // nobody was watching, and only one of them may be selected on.
    const map = await record(fixture());

    expect(packagesOf(map, 'test/b.test.mjs')).toEqual([]);
  }, 120_000);

  it('leaves a package nothing executed out of every entry', async () => {
    // `right-pad` is installed and imported by nothing. It is in the inventory,
    // so a bump to it is a change covsel watched and no test needs; that
    // measurement is only sound because the recorder would have seen it run.
    const map = await record(fixture());

    for (const entry of map.entries) expect(entry.packages).not.toContain('right-pad');
    expect(Object.keys(map.dependencies?.inventory ?? {})).toContain('right-pad');
  }, 120_000);
});

describe('recording what was installed', () => {
  it('stamps the map with the tree and the proof it was current', async () => {
    const map = await record(fixture());

    expect(map.dependencies?.manager).toBe('pnpm');
    expect(map.dependencies?.marker).toBe('node_modules/.pnpm/lock.yaml');
    expect(map.dependencies?.markerHash).toMatch(/^sha256:/);
    // Edges rather than versions: which resolver got which copy, so a patch or
    // an importer moving between two installed versions is visible.
    expect(map.dependencies?.inventory['left-pad']).toEqual([
      '.:node_modules/left-pad@1.3.0',
    ]);
    expect(map.dependencies?.inventory['right-pad']).toEqual([
      '.:node_modules/right-pad@2.0.0',
    ]);
  }, 120_000);

  it('records nothing when the package manager leaves no proof', async () => {
    // A bun project. The packages each test ran are still recorded, but with no
    // way to tell a fresh tree from a stale one there is nothing to measure a
    // change against, so nothing here can ever answer a dependency change --
    // which for bun means its sentinels answer it or nothing does, since the
    // default list does not name `bun.lock`.
    const map = await record(fixture({ marker: false }));

    expect(map.dependencies).toBeUndefined();
    expect(packagesOf(map, 'test/a.test.mjs')).toContain('left-pad');
  }, 120_000);

  it('records nothing for a recorder that does not watch packages', async () => {
    const cwd = fixture();
    const config = resolveConfig({ sourceGlobs: ['src/**'] });
    const base = vouchedRecorder(cwd, config);
    const blind: Recorder = {
      observes: OBSERVES_EVERYTHING,
      async record(file) {
        const units = await base.record!(file);
        return units.map(({ packages: _drop, ...unit }) => unit);
      },
    };

    const map = await record(cwd, blind);

    // The inventory would be perfectly accurate; it is the entries that cannot
    // be trusted, and an inventory next to entries whose silence means nothing
    // is exactly the pairing that skips tests.
    expect(map.dependencies).toBeUndefined();
    expect(map.entries.every((e) => e.packages === undefined)).toBe(true);
  }, 120_000);
});

describe('what the generic recorder may claim about the command it was handed', () => {
  /** The command as the recorder receives it: a string somebody typed. */
  const handed = (cwd: string) =>
    createGenericRecorder({
      command: ['node', '--test'],
      cwd,
      config: resolveConfig({ sourceGlobs: ['src/**'] }),
    });

  it('claims no package observation for a command nobody vouched for', () => {
    // Every command reaches this recorder as an opaque argv, and one that drives
    // a browser or shells out to another runtime is indistinguishable from one
    // that runs everything under NODE_V8_COVERAGE. Declaring anyway would vouch
    // for packages nothing watched.
    //
    // A bare directory rather than the fixture: the declaration is made when the
    // recorder is built, before anything has been run or read.
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-pkgclaim-'));
    dirs.push(cwd);

    expect(handed(cwd).observesPackages).toBeUndefined();
  });

  it('leaves its units silent about packages rather than reporting what it cannot stand behind', async () => {
    const units = await handed(fixture()).record!('test/a.test.mjs');

    expect(units).toHaveLength(1);
    // The silence is a choice, not an empty recording: this unit saw the test
    // execute `src/a.mjs`, which imports `left-pad`. What it declines to say is
    // that it would have seen every package, wherever the command ran one.
    expect(units[0]?.files.map((f) => f.file)).toContain('src/a.mjs');
    expect(units[0]?.packages).toBeUndefined();
  }, 120_000);

  it('records no inventory beside entries whose silence would be read as a measurement', async () => {
    // This is the pairing selection will read: a package in the inventory that
    // no entry credits means "installed and never ran", so a bump to it need
    // select nothing. Recording it for an unvouched command would say that of
    // every package the run executed where the dump could not reach -- so the
    // map carries neither half and holds no opinion about a dependency change.
    const cwd = fixture();
    const map = await record(cwd, handed(cwd));

    expect(map.entries.length).toBeGreaterThan(0);
    expect(map.dependencies).toBeUndefined();
    expect(map.entries.every((e) => e.packages === undefined)).toBe(true);
  }, 120_000);

  it('claims it once the caller vouches for the command', async () => {
    // The claim is available, it just belongs to whoever knows what is being
    // run. Nothing about the recording changes; only who stands behind it.
    const cwd = fixture();
    const config = resolveConfig({ sourceGlobs: ['src/**'] });

    expect(vouchedRecorder(cwd, config).observesPackages).toBe(true);

    const map = await record(cwd);
    expect(map.dependencies?.inventory['left-pad']).toEqual([
      '.:node_modules/left-pad@1.3.0',
    ]);
    expect(packagesOf(map, 'test/a.test.mjs')).toContain('left-pad');
  }, 120_000);
});

describe('a recorder is held to its package declaration', () => {
  const unit = (packages?: string[]): RecordedUnit => ({
    test: { file: 'test/a.test.mjs' },
    files: [],
    blocks: [],
    ...(packages ? { packages } : {}),
  });

  async function recordWith(observesPackages: boolean, unit: RecordedUnit) {
    const cwd = fixture();
    const config = resolveConfig({ sourceGlobs: ['src/**'] });
    return await recordMap({
      cwd,
      config,
      recorder: {
        observes: OBSERVES_EVERYTHING,
        ...(observesPackages ? { observesPackages: true } : {}),
        record: async () => [unit],
      },
    });
  }

  it('refuses a declaring recorder whose unit says nothing about packages', async () => {
    // Written as a measurement it never made: the entry would read as a test
    // running no vendored code, and every dependency it really uses would go
    // unselected on a bump.
    const result = await recordWith(true, unit());

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toContain('recorded no package list');
  }, 120_000);

  it('refuses a non-declaring recorder that reports packages anyway', async () => {
    // A recall nobody stood behind. The entry would be trusted for exactly the
    // packages the recorder's blind spots hid from it.
    // Declining costs nothing: the packages are dropped, the map keeps none,
    // and that is exactly today's behaviour. Failing instead would break every
    // recorder that wraps another and forwards its units under its own narrower
    // declaration, which is the ordinary way to build one.
    const result = await recordWith(false, unit(['left-pad']));

    expect(result.ok).toBe(true);
    expect(result.map?.entries[0]?.packages).toBeUndefined();
    expect(result.map?.dependencies).toBeUndefined();
  }, 120_000);
});

describe('a package a bundler fused into built output', () => {
  it('is credited to the test that ran the bundle', async () => {
    // Nothing under node_modules executes here: left-pad's code is inside
    // dist/bundle.js, and only the bundle's source map says it is there.
    // Reading the script path alone would leave the package in the inventory
    // with no entry crediting it, which is read as "installed and never ran" --
    // so every test that uses it through the bundle would be skipped on a bump.
    //
    // Written by hand rather than built, so the shape under test is stated
    // rather than inherited from whichever bundler happens to be installed.
    const cwd = fixture();
    write(
      cwd,
      'dist/bundle.js',
      'const pad = (s) => ` ${s}`;\n' +
        "export const a = () => pad('a');\n" +
        '//# sourceMappingURL=bundle.js.map\n',
    );
    write(
      cwd,
      'dist/bundle.js.map',
      `${JSON.stringify({
        version: 3,
        file: 'bundle.js',
        sources: ['../src/a.mjs', '../node_modules/left-pad/index.js'],
        mappings: '',
      })}\n`,
    );
    write(
      cwd,
      'test/bundled.test.mjs',
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { a } from '../dist/bundle.js';\ntest('bundled', () => assert.equal(a(), ' a'));\n",
    );
    commitAll(cwd, 'bundle');

    const map = await record(cwd);

    expect(packagesOf(map, 'test/bundled.test.mjs')).toContain('left-pad');
    // The first-party source behind the bundle is still credited as a file, so
    // this adds an axis rather than replacing one.
    expect(
      map.entries.find((e) => e.test.file === 'test/bundled.test.mjs')?.files,
    ).toEqual([expect.objectContaining({ file: 'src/a.mjs' })]);
  }, 120_000);
});

describe('combining observation windows', () => {
  const window = (packages?: string[]) => ({
    files: [],
    blocks: [],
    observes: ['src/**'],
    ...(packages ? { packages } : {}),
  });

  it('unions what each window saw run', () => {
    const combined = combineObservations({ file: 't.mjs' }, [
      window(['left-pad']),
      window(['right-pad']),
    ]);

    expect(combined.packages).toEqual(['left-pad', 'right-pad']);
  });

  it('knows nothing when a window was blind to packages', () => {
    // Taking the seeing window's word would credit the unit with a list missing
    // whatever ran inside the other isolate. Recording then refuses the unit
    // outright for a declaring recorder, which is louder than under-crediting.
    const combined = combineObservations({ file: 't.mjs' }, [
      window(['left-pad']),
      window(),
    ]);

    expect(combined.packages).toBeUndefined();
  });
});

describe('merging shard maps', () => {
  const dependencies = (markerHash: string, inventory: Record<string, string[]>) => ({
    manager: 'pnpm',
    marker: 'node_modules/.pnpm/lock.yaml',
    markerHash,
    inventory,
  });

  const shard = (
    file: string,
    packages: string[] | undefined,
    deps?: CoverageMap['dependencies'],
  ): CoverageMap => ({
    schemaVersion: MAP_SCHEMA_VERSION,
    granularity: 'file',
    commit: 'abc',
    recordedAt: '2026-01-01T00:00:00.000Z',
    sentinelHashes: {},
    observed: ['**'],
    ...(deps ? { dependencies: deps } : {}),
    entries: [{ test: { file }, files: [], ...(packages ? { packages } : {}) }],
  });

  it('keeps an inventory every shard agrees on', () => {
    const deps = dependencies('sha256:same', { 'left-pad': ['1.3.0'] });
    const merged = mergeMaps([
      shard('a.mjs', ['left-pad'], deps),
      shard('b.mjs', [], deps),
    ]);

    expect(merged.dependencies?.inventory).toEqual({ 'left-pad': ['1.3.0'] });
  });

  it('drops a name the shards saw at different versions', () => {
    // Their entries describe different resolutions of one name, so neither
    // vouches for the other's. Dropped, the name falls open on any change.
    const merged = mergeMaps([
      shard(
        'a.mjs',
        [],
        dependencies('sha256:same', { lodash: ['4.0.0'], ok: ['1.0.0'] }),
      ),
      shard(
        'b.mjs',
        [],
        dependencies('sha256:same', { lodash: ['3.0.0'], ok: ['1.0.0'] }),
      ),
    ]);

    expect(merged.dependencies?.inventory).toEqual({ ok: ['1.0.0'] });
  });

  it('drops the inventory when the shards installed different trees', () => {
    const merged = mergeMaps([
      shard('a.mjs', [], dependencies('sha256:one', { 'left-pad': ['1.3.0'] })),
      shard('b.mjs', [], dependencies('sha256:two', { 'left-pad': ['1.3.0'] })),
    ]);

    expect(merged.dependencies).toBeUndefined();
  });

  it('drops the inventory when a shard says nothing about packages', () => {
    const deps = dependencies('sha256:same', { 'left-pad': ['1.3.0'] });
    const merged = mergeMaps([
      shard('a.mjs', ['left-pad'], deps),
      shard('b.mjs', undefined),
    ]);

    expect(merged.dependencies).toBeUndefined();
  });

  it('drops the inventory when there are no entries to pair it with', () => {
    // "Every entry has packages" is vacuously true of no entries at all, and an
    // inventory beside none would say every package was installed and ran
    // nowhere. A map with no entries already forces a full run elsewhere, so
    // this cannot bite today — but the pairing is what selection will rely on,
    // and it should hold as written rather than by luck.
    const deps = dependencies('sha256:same', { 'left-pad': ['1.3.0'] });
    const empty: CoverageMap = { ...shard('a.mjs', [], deps), entries: [] };

    expect(mergeMaps([empty]).dependencies).toBeUndefined();
  });

  it('drops the inventory when any entry says nothing about packages', () => {
    // Both shards claim the same tree, but one entry was recorded without a
    // package list -- a map from another producer, or one half-migrated.
    // Recording cannot make this, and selection is about to rely on the pairing
    // holding, so the merge enforces it rather than assuming it.
    const deps = dependencies('sha256:same', { 'left-pad': ['1.3.0'] });
    const merged = mergeMaps([
      shard('a.mjs', ['left-pad'], deps),
      shard('b.mjs', undefined, deps),
    ]);

    expect(merged.dependencies).toBeUndefined();
  });

  it('forgets a test packages only one shard watched', () => {
    // The same test id in two shards, one of which recorded no packages for it.
    // Keeping the other's list would let a bump to a package only that run
    // executed miss this entry.
    const deps = dependencies('sha256:same', { 'left-pad': ['1.3.0'] });
    const merged = mergeMaps([
      shard('a.mjs', ['left-pad'], deps),
      shard('a.mjs', undefined),
    ]);

    expect(merged.entries[0]?.packages).toBeUndefined();
    expect(merged.dependencies).toBeUndefined();
  });
});
