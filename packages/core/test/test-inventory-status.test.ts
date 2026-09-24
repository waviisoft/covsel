import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commitAll, write } from './helpers/repo.js';
import {
  computeStatus,
  createGenericRecorder,
  explainPath,
  type CoverageMap,
  type CovselConfig,
  recordMap,
  resolveConfig,
} from '../src/index.js';

/**
 * `covsel status`/`covsel explain` reporting inventory drift -- covsel/covsel#123.
 *
 * Neither command decides anything from this; both are read-only reports of
 * what the next selection would do, so what they say has to match what
 * `testInventoryChange` (exercised directly in test-inventory.test.ts and
 * through selection in test-inventory-selection.test.ts) actually decides.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function inventoryCommand(inventory: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-inv-status-'));
  dirs.push(dir);
  const path = join(dir, 'inventory.cjs');
  writeFileSync(
    path,
    `process.stdout.write(${JSON.stringify(JSON.stringify(inventory))});\n`,
  );
  return `node ${JSON.stringify(path)}`;
}

const HARNESS = 'sha:harness111';

async function fixture(): Promise<{ cwd: string; config: CovselConfig }> {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-testinv-status-'));
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

function withInventory(config: CovselConfig, command: string): CovselConfig {
  return resolveConfig({ ...config, inventory: { command } });
}

describe('covsel status', () => {
  it('reports how many inventory ids are new or changed since the recording', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS,
        entries: [{ id: { file: 'spec:a.md', name: 'x' }, version: 'v1' }],
      },
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS,
        entries: [
          { id: { file: 'spec:a.md', name: 'x' }, version: 'v1' }, // unchanged
          { id: { file: 'spec:a.md', name: 'y' }, version: 'v1' }, // new
        ],
      }),
    );

    const status = await computeStatus({ cwd, config: configNow });

    expect(status.testInventory).toEqual({
      source: HARNESS,
      changedCount: 1,
      totalCount: 2,
    });
  });

  it('says nothing about drift when the project configures no inventory', async () => {
    const { cwd, config } = await fixture();
    const status = await computeStatus({ cwd, config });
    expect(status.testInventory).toBeUndefined();
  });

  it('says nothing about drift when the inventory could not be read -- nextFullRunReason already does', async () => {
    const { cwd, config } = await fixture();
    const configNow = withInventory(config, 'covsel-command-that-does-not-exist');

    const status = await computeStatus({ cwd, config: configNow });

    expect(status.testInventory).toBeUndefined();
    expect(status.nextIsFullRun).toBe(true);
    expect(status.nextFullRunReason).toContain('could not be produced');
  });

  it('is a full run when the map recorded an inventory but this run configures none', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS,
        entries: [{ id: { file: 'spec:a.md', name: 'x' }, version: 'v1' }],
      },
    });

    const status = await computeStatus({ cwd, config }); // `config` sets no inventory

    expect(status.testInventory).toBeUndefined();
    expect(status.nextIsFullRun).toBe(true);
    expect(status.nextFullRunReason).toContain('configures none');
  });

  it('spawns the inventory command exactly once, not once per drift check and once per full-run check', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: { source: HARNESS, entries: [] },
    });
    const counterFile = join(cwd, 'invocations');
    const scriptPath = join(cwd, 'counting-inventory.cjs');
    writeFileSync(
      scriptPath,
      `const fs = require('node:fs');\n` +
        `fs.appendFileSync(${JSON.stringify(counterFile)}, 'x');\n` +
        `process.stdout.write(${JSON.stringify(
          JSON.stringify({ source: HARNESS, entries: [] }),
        )});\n`,
    );
    const configNow = withInventory(config, `node ${JSON.stringify(scriptPath)}`);

    await computeStatus({ cwd, config: configNow });

    expect(readFileSync(counterFile, 'utf8')).toBe('x');
  });
});

describe('covsel explain', () => {
  it('reports drift restricted to the explained path', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: {
        source: HARNESS,
        entries: [{ id: { file: 'spec:a.md', name: 'x' }, version: 'v1' }],
      },
      entries: [
        ...map.entries,
        { test: { file: 'spec:a.md', name: 'x' }, files: [] },
        { test: { file: 'spec:a.md', name: 'y' }, files: [] },
      ],
    });
    const configNow = withInventory(
      config,
      inventoryCommand({
        source: HARNESS,
        entries: [
          { id: { file: 'spec:a.md', name: 'x' }, version: 'v1' }, // unchanged
          { id: { file: 'spec:a.md', name: 'y' }, version: 'v2' }, // changed
        ],
      }),
    );

    const result = await explainPath({ cwd, config: configNow, path: 'spec:a.md' });

    expect(result.ok).toBe(true);
    expect(result.test?.inventoryDrift).toEqual({ changedCount: 1, totalCount: 2 });
  });

  it('spawns the inventory command exactly once, not once per drift check and once per full-run check', async () => {
    const { cwd, config } = await fixture();
    const map = readMap(cwd, config);
    writeMap(cwd, config, {
      ...map,
      testInventory: { source: HARNESS, entries: [] },
      entries: [...map.entries, { test: { file: 'spec:a.md', name: 'x' }, files: [] }],
    });
    const counterFile = join(cwd, 'invocations');
    const scriptPath = join(cwd, 'counting-inventory.cjs');
    writeFileSync(
      scriptPath,
      `const fs = require('node:fs');\n` +
        `fs.appendFileSync(${JSON.stringify(counterFile)}, 'x');\n` +
        `process.stdout.write(${JSON.stringify(
          JSON.stringify({ source: HARNESS, entries: [] }),
        )});\n`,
    );
    const configNow = withInventory(config, `node ${JSON.stringify(scriptPath)}`);

    await explainPath({ cwd, config: configNow, path: 'spec:a.md' });

    expect(readFileSync(counterFile, 'utf8')).toBe('x');
  });
});
