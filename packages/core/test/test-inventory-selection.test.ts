import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commitAll, write } from './helpers/repo.js';
import {
  createGenericRecorder,
  mergeMaps,
  OBSERVES_EVERYTHING,
  type CoverageMap,
  type CovselConfig,
  type Recorder,
  recordMap,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * Selecting on an inventory of tests that aren't files in this repository --
 * covsel/covsel#123.
 *
 * The scenarios these entries name live in a spec pinned from elsewhere, so
 * nothing in this repository's own diff ever mentions them. The comparison has
 * to stand entirely on its own: a scenario new to the inventory, one whose
 * version moved, and one with no version at all all have to run without any
 * source file changing, and a moved `source` has to run the whole suite the
 * way a sentinel does.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A shell command covsel can run as `inventory.command`, printing fixed JSON.
 * Lives in its own scratch directory, addressed absolutely, so it works
 * whatever `cwd` a recording or a selection runs it from.
 */
function inventoryCommand(inventory: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-inv-cmd-'));
  dirs.push(dir);
  const path = join(dir, 'inventory.cjs');
  writeFileSync(
    path,
    `process.stdout.write(${JSON.stringify(JSON.stringify(inventory))});\n`,
  );
  return `node ${JSON.stringify(path)}`;
}

function failingInventoryCommand(message: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-inv-fail-'));
  dirs.push(dir);
  const path = join(dir, 'fail.cjs');
  writeFileSync(
    path,
    `process.stderr.write(${JSON.stringify(message)});\nprocess.exitCode = 1;\n`,
  );
  return `node ${JSON.stringify(path)}`;
}

const HARNESS_V1 = 'sha:harness111';
const HARNESS_V2 = 'sha:harness222';

/** A repository with one ordinary product test, recorded and committed. */
async function fixture(): Promise<{ cwd: string; config: CovselConfig }> {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-testinv-'));
  dirs.push(cwd);
  write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
  write(cwd, 'src/a.mjs', 'export const a = 1;\n');
  write(
    cwd,
    'test/a.test.mjs',
    "import { test } from 'node:test';\nimport { a } from '../src/a.mjs';\ntest('a', () => { a; });\n",
  );
  write(cwd, '.gitignore', '.covsel/\n');
  commitAll(cwd);

  const config = resolveConfig({
    sourceGlobs: ['src/**'],
    testGlobs: ['test/**/*.test.mjs'],
  });

  const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
  const result = await recordMap({ cwd, config, recorder });
  if (!result.ok) throw new Error(`fixture failed to record: ${result.error}`);
  return { cwd, config };
}

const mapPath = (cwd: string, config: CovselConfig): string =>
  join(cwd, config.store.dir, 'map.json');

function readMap(cwd: string, config: CovselConfig): CoverageMap {
  return JSON.parse(readFileSync(mapPath(cwd, config), 'utf8')) as CoverageMap;
}

function writeMap(cwd: string, config: CovselConfig, map: CoverageMap): void {
  writeFileSync(mapPath(cwd, config), `${JSON.stringify(map, null, 2)}\n`);
}

/** The fixture's config, with `inventory.command` set to `command`. */
function withInventory(config: CovselConfig, command: string): CovselConfig {
  return resolveConfig({ ...config, inventory: { command } });
}

describe('recording a test inventory', () => {
  it('stores the inventory the command produced', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-testinv-rec-'));
    dirs.push(cwd);
    write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
    write(cwd, 'src/a.mjs', 'export const a = 1;\n');
    write(
      cwd,
      'test/a.test.mjs',
      "import { test } from 'node:test';\ntest('a', () => {});\n",
    );
    write(cwd, '.gitignore', '.covsel/\n');
    commitAll(cwd);
    const inv = {
      source: HARNESS_V1,
      entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
    };
    const config = resolveConfig({
      sourceGlobs: ['src/**'],
      testGlobs: ['test/**/*.test.mjs'],
      inventory: { command: inventoryCommand(inv) },
    });
    const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(true);
    const map = readMap(cwd, config);
    expect(map.testInventory).toEqual(inv);
  });

  it('refuses to write a map when the configured command fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-testinv-recfail-'));
    dirs.push(cwd);
    write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
    write(cwd, 'src/a.mjs', 'export const a = 1;\n');
    write(
      cwd,
      'test/a.test.mjs',
      "import { test } from 'node:test';\ntest('a', () => {});\n",
    );
    write(cwd, '.gitignore', '.covsel/\n');
    commitAll(cwd);
    const config = resolveConfig({
      sourceGlobs: ['src/**'],
      testGlobs: ['test/**/*.test.mjs'],
      inventory: { command: failingInventoryCommand('no intent repo pinned') },
    });
    const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not be produced');
    expect(result.error).toContain('no intent repo pinned');
  });

  it('reads the inventory before recording, so a failing command never runs the suite', async () => {
    // An unpinned intent repo can move mid-recording, which would otherwise
    // store a later version against coverage measured under an earlier one.
    // Reading first also means a command that cannot be produced fails before
    // a real recording -- proven here by a recorder that fails the test if
    // it is ever asked to record anything.
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-testinv-order-'));
    dirs.push(cwd);
    write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
    write(cwd, 'test/a.test.mjs', '// a\n');
    write(cwd, '.gitignore', '.covsel/\n');
    commitAll(cwd);
    const config = resolveConfig({
      testGlobs: ['test/**/*.test.mjs'],
      inventory: { command: failingInventoryCommand('unreachable') },
    });
    const neverRecord: Recorder = {
      observes: OBSERVES_EVERYTHING,
      record: async () => {
        throw new Error('the recorder should never have been asked to record');
      },
    };

    const result = await recordMap({ cwd, config, recorder: neverRecord });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([]); // not a per-file failure -- record() never ran
    expect(result.error).toContain('could not be produced');
  });
});

describe('selecting on an inventory change', () => {
  it('runs a scenario new to the inventory, with no source file changing', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, { ...map, testInventory: { source: HARNESS_V1, entries: [] } });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' } }],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(false);
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's1' }]),
    );
  });

  it('runs a scenario whose version changed since the recording', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
      },
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v2' }],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(false);
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's1' }]),
    );
  });

  it('leaves an unchanged, versioned scenario unselected', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
      },
      // A real entry, covering a source nothing in this test changes -- an id
      // with no entry at all is a recording gap (covered separately below)
      // and always runs, which would otherwise mask what this test means to
      // check: an unchanged version, with real coverage, stays unselected.
      entries: [
        ...map.entries,
        {
          test: { file: 'spec:features/agenda.md', name: 's1' },
          files: [{ file: 'src/a.mjs', fileHash: 'sha256:whatever' }],
        },
      ],
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(false);
    expect(result.selected).not.toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's1' }]),
    );
  });

  it('always runs a scenario with no version, whatever the map recorded', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 'pending' } }],
      },
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 'pending' } }],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 'pending' }]),
    );
  });

  it('is a full run when the harness source moved, sentinel-style', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
      },
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V2,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain(HARNESS_V1);
    expect(result.reason).toContain(HARNESS_V2);
  });

  it('is a full run, never an empty selection, when the inventory command fails', async () => {
    const { cwd, config } = await fixture();
    const configNow = withInventory(
      config,
      failingInventoryCommand('harness unavailable'),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('could not be produced');
  });

  it('does not force a run for an id the current inventory dropped', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS_V1,
        entries: [
          { id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' },
          { id: { file: 'spec:features/removed.md', name: 'gone' }, version: 'v1' },
        ],
      },
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(false);
    expect(result.selected).not.toEqual(
      expect.arrayContaining([{ file: 'spec:features/removed.md', name: 'gone' }]),
    );
  });
});

/**
 * A map recorded against a test inventory claims a baseline this run has to
 * be able to check. If `inventory` drifts out of step between the job that
 * recorded the map and the one selecting against it -- a missing env var, a
 * reverted config field -- this run cannot ask whether any id's version
 * moved, and reading that as "nothing changed" would silently drop the whole
 * point of the feature. It has to fall open instead, the same way an
 * unreadable installed-package tree does for `dependencies`.
 */
describe('a map recorded against an inventory, selected against none', () => {
  /** A repository with one product test, plus a hand-added virtual entry. */
  async function fixtureWithVirtualEntry(
    virtualEntry: CoverageMap['entries'][number],
  ): Promise<{ cwd: string; config: CovselConfig }> {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS_V1,
        entries: [{ id: virtualEntry.test, version: 'v1' }],
      },
      entries: [...map.entries, virtualEntry],
    });
    return { cwd, config };
  }

  it('is a full run, even with a real, unrelated source change alongside it', async () => {
    const { cwd, config } = await fixtureWithVirtualEntry({
      test: { file: 'spec:features/agenda.md', name: 's1' },
      files: [{ file: 'src/a.mjs', fileHash: 'sha256:whatever' }],
    });
    write(cwd, 'src/a.mjs', 'export const a = 2;\n');
    // `config` sets no `inventory` at all, though the map was recorded
    // against one -- this run cannot ask whether s1's version moved.

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('configures none');
  });

  it('names the inventory-sourced ids the map recorded in that full run', async () => {
    const { cwd, config } = await fixtureWithVirtualEntry({
      test: { file: 'spec:features/agenda.md', name: 's1' },
      files: [],
    });

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(true);
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's1' }]),
    );
  });
});

describe('an inventory id with no recording at all', () => {
  it('runs even though its version has not changed -- a recording gap, not agreement', async () => {
    // The map's testInventory names s1 and s2 at the same version the current
    // inventory reports; s2 was never observed (crashed, or ran in a shard
    // this map never saw), so it has no entry. Silence must not read as
    // "unchanged": s2 has to run until something actually records it.
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS_V1,
        entries: [
          { id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' },
          { id: { file: 'spec:features/agenda.md', name: 's2' }, version: 'v1' },
        ],
      },
      entries: [
        ...map.entries,
        {
          test: { file: 'spec:features/agenda.md', name: 's1' },
          files: [{ file: 'src/a.mjs', fileHash: 'sha256:whatever' }],
        },
        // No entry for s2.
      ],
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [
          { id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' },
          { id: { file: 'spec:features/agenda.md', name: 's2' }, version: 'v1' },
        ],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(false);
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's2' }]),
    );
    // s1 has a real entry and nothing it covers changed, so it stays out.
    expect(result.selected).not.toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's1' }]),
    );
  });

  it('is covered by a whole-file entry for the same (virtual) file, and does not need its own', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
      },
      // Recorded at file granularity -- no `name` -- which already speaks for
      // every scenario in this virtual file, s1 included.
      entries: [...map.entries, { test: { file: 'spec:features/agenda.md' }, files: [] }],
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(false);
    // Selected because the whole-file entry credits nothing (unmeasured), not
    // because s1 was treated as unmapped on top of that.
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md' }]),
    );
  });

  it('runs after a merge that lost the shard which would have recorded it', async () => {
    // Every shard read the same inventory (that part is unconditional
    // metadata, not sharded coverage), so the merged map keeps the full
    // `testInventory` even though one shard -- the one that would have
    // produced s2's entry -- never reported back. The gap this leaves is
    // exactly the one `unmappedInventory` (in `commands.ts`) exists to catch,
    // and nothing about going through a merge should exempt it.
    const { cwd, config } = await fixture();
    const recordedMap = readMap(cwd, config);
    const testInventory = {
      source: HARNESS_V1,
      entries: [
        { id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' },
        { id: { file: 'spec:features/agenda.md', name: 's2' }, version: 'v1' },
      ],
    };
    const shard1: CoverageMap = {
      ...recordedMap,
      testInventory,
      entries: [
        ...recordedMap.entries,
        {
          test: { file: 'spec:features/agenda.md', name: 's1' },
          files: [{ file: 'src/a.mjs', fileHash: 'sha256:whatever' }],
        },
      ],
    };
    // shard2 recorded nothing of its own for s2 (crashed, or never got to
    // it) -- only the same inventory metadata every shard reads.
    const shard2: CoverageMap = { ...recordedMap, testInventory, entries: [] };
    const merged = mergeMaps([shard1, shard2]);
    writeMap(cwd, config, merged);
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [
          { id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' },
          { id: { file: 'spec:features/agenda.md', name: 's2' }, version: 'v1' },
        ],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(false);
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's2' }]),
    );
  });
});

/**
 * A full run's own `selected`/`tests` output has to name what the inventory
 * currently says exists -- not what a map (if there is a usable one at all)
 * happened to record -- because it is the answer a harness-driving consumer
 * actually runs. The live inventory has to be read before any of the several
 * things that can themselves cause a full run (no map, an unusable map, an
 * untrusted base), not only after all of them have been ruled out: otherwise
 * exactly the runs most likely to be a full run are the ones whose own output
 * forgets the inventory axis entirely.
 */
describe("a full run's own output names what the inventory says exists now", () => {
  it('names a live scenario when there is no map at all yet', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-testinv-nomap-'));
    dirs.push(cwd);
    write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
    write(cwd, 'test/a.test.mjs', '// a\n');
    write(cwd, '.gitignore', '.covsel/\n');
    commitAll(cwd);
    const config = resolveConfig({
      testGlobs: ['test/**/*.test.mjs'],
      inventory: {
        command: inventoryCommand({
          source: HARNESS_V1,
          entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' } }],
        }),
      },
    });
    // No `covsel record` has ever run -- `.covsel/map.json` does not exist.

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(true);
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's1' }]),
    );
  });

  it('names a live scenario when the stored map is an old, unusable schema', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, { ...map, schemaVersion: 1 } as unknown as CoverageMap);
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' } }],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(true);
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's1' }]),
    );
  });

  it('names a scenario new since the recording, even with an untrusted base', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    // No recorded commit, with a git work tree present, is exactly what makes
    // the base untrusted -- the same state a shallow clone or a pruned
    // history leaves selection in.
    delete map.commit;
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' }],
      },
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS_V1,
        entries: [
          { id: { file: 'spec:features/agenda.md', name: 's1' }, version: 'v1' },
          { id: { file: 'spec:features/agenda.md', name: 's2' }, version: 'v1' }, // new
        ],
      }),
    );

    const result = await selectAffected({ cwd, config: configNow });

    expect(result.fullRun).toBe(true);
    expect(result.reason).toContain('commit');
    expect(result.selected).toEqual(
      expect.arrayContaining([
        { file: 'spec:features/agenda.md', name: 's1' },
        { file: 'spec:features/agenda.md', name: 's2' },
      ]),
    );
  });

  it('reads the inventory exactly once even across an early full-run return', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-testinv-oneread-'));
    dirs.push(cwd);
    write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
    write(cwd, 'test/a.test.mjs', '// a\n');
    write(cwd, '.gitignore', '.covsel/\n');
    commitAll(cwd);
    const counterFile = join(cwd, 'invocations');
    const scriptPath = join(cwd, 'counting-inventory.cjs');
    writeFileSync(
      scriptPath,
      `const fs = require('node:fs');\n` +
        `fs.appendFileSync(${JSON.stringify(counterFile)}, 'x');\n` +
        `process.stdout.write(${JSON.stringify(
          JSON.stringify({ source: HARNESS_V1, entries: [] }),
        )});\n`,
    );
    const config = resolveConfig({
      testGlobs: ['test/**/*.test.mjs'],
      inventory: { command: `node ${JSON.stringify(scriptPath)}` },
    });
    // No map recorded -- this is the early "no test files matched"-adjacent
    // full-run path (here, "no usable map"), which used to return before the
    // inventory was ever read at all.

    await selectAffected({ cwd, config });

    const invocations = readFileSync(counterFile, 'utf8');
    expect(invocations).toBe('x');
  });
});
