import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commitAll, write } from './helpers/repo.js';
import {
  createGenericRecorder,
  type CoverageMap,
  type CovselConfig,
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
 * The map's own recorded inventory has to keep an inventory-sourced entry
 * eligible for the ordinary coverage-based selector even when *this run*
 * configures no `inventory` at all -- a config drifting out of step between
 * the job that recorded the map and the one selecting against it (a missing
 * env var, a reverted config field) must not silently drop a real,
 * coverage-based hit for a test this map genuinely has an entry and covered
 * sources for. That drop is not something `testInventoryChange` can catch on
 * its own, because with no `inventory` configured this run it is never asked
 * at all -- it is `commands.ts`'s own suite-membership sets (`inSuite`,
 * `discovered`, and the `unmeasured` fold into `wholeFile`) that have to know
 * about a map's recorded inventory independently of the current config.
 */
describe('an inventory-sourced entry survives ordinary selection on its own', () => {
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

  it('is selected on a real source-file change, though config sets no inventory', async () => {
    const { cwd, config } = await fixtureWithVirtualEntry({
      test: { file: 'spec:features/agenda.md', name: 's1' },
      files: [{ file: 'src/a.mjs', fileHash: 'sha256:whatever' }],
    });
    write(cwd, 'src/a.mjs', 'export const a = 2;\n'); // the source it covers changed
    // `config` here sets no `inventory` at all -- this run neither reads nor
    // needs to read the current inventory for this to work.

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(false);
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 's1' }]),
    );
  });

  it('always runs when it credits no source, though config sets no inventory', async () => {
    const { cwd, config } = await fixtureWithVirtualEntry({
      test: { file: 'spec:features/agenda.md', name: 's1' },
      files: [], // the recorder could not see what this test executed
    });

    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(false);
    // Whole-file, the same as an unmeasured *real* entry gets: a recorder that
    // could not see this scenario has not earned trust for whatever else
    // shares its (virtual) file, so the name is dropped and the file runs in
    // full, not just the one scenario recorded blind.
    expect(result.selected).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md' }]),
    );
  });
});
