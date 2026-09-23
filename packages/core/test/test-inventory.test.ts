import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAP_SCHEMA_VERSION,
  OBSERVES_EVERYTHING,
  parseTestInventory,
  readTestInventory,
  recordedConfig,
  resolveConfig,
  testInventoryChange,
  type CoverageMap,
} from '../src/index.js';

/**
 * Reading and comparing a test inventory -- covsel/covsel#123.
 *
 * `parseTestInventory`/`readTestInventory` are the boundary between an
 * external command's output and covsel's own JSON shape, and every ambiguity
 * there has to fail toward "cannot be trusted" rather than toward a guess.
 * `testInventoryChange` is the comparison selection reads, and it has to fail
 * toward running more: new, changed, and versionless ids all run, a moved
 * `source` runs everything, and a command that cannot be produced or parsed
 * never reads as an empty inventory.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A script covsel can spawn as `inventory.command`, printing fixed JSON. */
function inventoryScript(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-inv-'));
  dirs.push(dir);
  const path = join(dir, 'inventory.cjs');
  writeFileSync(path, `process.stdout.write(${JSON.stringify(text)});\n`);
  return `node ${JSON.stringify(path)}`;
}

/** A script that fails, printing something to stderr on the way out. */
function failingScript(stderr: string, code = 1): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-inv-fail-'));
  dirs.push(dir);
  const path = join(dir, 'fail.cjs');
  writeFileSync(
    path,
    `process.stderr.write(${JSON.stringify(stderr)});\nprocess.exitCode = ${code};\n`,
  );
  return `node ${JSON.stringify(path)}`;
}

const VALID = JSON.stringify({
  source: 'sha:aaa111',
  entries: [
    { id: { file: 'spec:features/agenda.md', name: 'scenario-1' }, version: 'v1' },
    { id: { file: 'spec:features/agenda.md', name: 'scenario-2' } }, // no version
  ],
});

describe('resolveConfig: inventory', () => {
  it('is unset by default, so a project with no inventory is unaffected', () => {
    expect(resolveConfig({}).inventory).toBeUndefined();
  });

  it('accepts { command: string }', () => {
    expect(
      resolveConfig({ inventory: { command: 'vellum suite extract' } }).inventory,
    ).toEqual({ command: 'vellum suite extract' });
  });

  it('refuses a value that is not { command: string }, before anything is selected on it', () => {
    expect(() => resolveConfig({ inventory: 'vellum suite extract' } as never)).toThrow(
      /inventory/,
    );
    expect(() => resolveConfig({ inventory: {} } as never)).toThrow(/inventory/);
    expect(() => resolveConfig({ inventory: { command: 7 } } as never)).toThrow(
      /inventory/,
    );
    expect(() => resolveConfig({ inventory: { command: '' } } as never)).toThrow(
      /inventory/,
    );
  });

  it('is inert: changing the command does not by itself force a full run', () => {
    // The comparison against what the map recorded is done by
    // `testInventoryChange`, against the inventory read fresh each run --
    // never against this string. See INERT_CONFIG_FIELDS in config.ts.
    const before = recordedConfig(
      resolveConfig({ inventory: { command: 'old command' } }),
    );
    const after = recordedConfig(
      resolveConfig({ inventory: { command: 'new command' } }),
    );
    expect(before).toEqual(after);
  });
});

describe('parseTestInventory', () => {
  it('accepts covsel’s own shape', () => {
    const result = parseTestInventory(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.inventory.source).toBe('sha:aaa111');
    expect(result.inventory.entries).toEqual([
      { id: { file: 'spec:features/agenda.md', name: 'scenario-1' }, version: 'v1' },
      { id: { file: 'spec:features/agenda.md', name: 'scenario-2' } },
    ]);
  });

  it('accepts an id with no name at all (whole-file granularity)', () => {
    const result = parseTestInventory(
      JSON.stringify({ source: 's', entries: [{ id: { file: 'a' }, version: '1' }] }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects text that is not JSON', () => {
    const result = parseTestInventory('not json');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.reason).toContain('did not print valid JSON');
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"hello"'],
    ['null', 'null'],
  ])('rejects %s at the top level', (_label, json) => {
    const result = parseTestInventory(json);
    expect(result.ok).toBe(false);
  });

  it('rejects a missing or empty source', () => {
    expect(parseTestInventory(JSON.stringify({ entries: [] })).ok).toBe(false);
    expect(parseTestInventory(JSON.stringify({ source: '', entries: [] })).ok).toBe(
      false,
    );
    expect(parseTestInventory(JSON.stringify({ source: 7, entries: [] })).ok).toBe(false);
  });

  it('rejects entries that are not a list', () => {
    const result = parseTestInventory(JSON.stringify({ source: 's', entries: 'nope' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.reason).toContain('entries');
  });

  it('rejects an entry with no id, or an id with no file', () => {
    expect(
      parseTestInventory(JSON.stringify({ source: 's', entries: [{ version: '1' }] })).ok,
    ).toBe(false);
    expect(
      parseTestInventory(
        JSON.stringify({ source: 's', entries: [{ id: { name: 'x' } }] }),
      ).ok,
    ).toBe(false);
    expect(
      parseTestInventory(JSON.stringify({ source: 's', entries: [{ id: { file: '' } }] }))
        .ok,
    ).toBe(false);
  });

  it('rejects a version or name that is not a string', () => {
    expect(
      parseTestInventory(
        JSON.stringify({ source: 's', entries: [{ id: { file: 'a' }, version: 7 }] }),
      ).ok,
    ).toBe(false);
    expect(
      parseTestInventory(
        JSON.stringify({ source: 's', entries: [{ id: { file: 'a', name: 7 } }] }),
      ).ok,
    ).toBe(false);
  });
});

describe('readTestInventory', () => {
  it('runs the configured command through a shell and parses its stdout', () => {
    const command = inventoryScript(VALID);
    const result = readTestInventory({ cwd: process.cwd(), command });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.inventory.source).toBe('sha:aaa111');
  });

  it('is a full-run failure when the command exits non-zero', () => {
    const command = failingScript('vellum: intent repo not pinned');
    const result = readTestInventory({ cwd: process.cwd(), command });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.reason).toContain('exited with status 1');
    expect(result.reason).toContain('vellum: intent repo not pinned');
  });

  it('is a full-run failure when the command cannot be run at all', () => {
    const result = readTestInventory({
      cwd: process.cwd(),
      command: 'covsel-command-that-does-not-exist-anywhere',
    });
    expect(result.ok).toBe(false);
  });

  it('is a full-run failure when the command prints something covsel cannot parse', () => {
    const command = inventoryScript('not json at all');
    const result = readTestInventory({ cwd: process.cwd(), command });
    expect(result.ok).toBe(false);
  });
});

const BASE_MAP: CoverageMap = {
  schemaVersion: MAP_SCHEMA_VERSION,
  granularity: 'file',
  recordedAt: new Date(0).toISOString(),
  sentinelHashes: {},
  observed: [...OBSERVES_EVERYTHING],
  entries: [{ test: { file: 'spec:features/agenda.md', name: 's1' }, files: [] }],
};

describe('testInventoryChange', () => {
  it('is undefined when the project configures no inventory', () => {
    expect(
      testInventoryChange({ cwd: process.cwd(), config: {}, map: BASE_MAP }),
    ).toBeUndefined();
  });

  it('is undefined for an entry-less map -- nothing to narrow either way', () => {
    const command = inventoryScript(VALID);
    expect(
      testInventoryChange({
        cwd: process.cwd(),
        config: { inventory: { command } },
        map: { ...BASE_MAP, entries: [] },
      }),
    ).toBeUndefined();
  });

  it('falls open when the inventory command fails', () => {
    const command = failingScript('boom');
    const result = testInventoryChange({
      cwd: process.cwd(),
      config: { inventory: { command } },
      map: BASE_MAP,
    });
    expect(result?.fallOpen).toContain('could not be produced');
  });

  it('runs every current id when the map recorded no inventory at all', () => {
    // Turning the feature on for a map that predates it: there is no baseline
    // to compare against, so every id reads as new -- the same reading an
    // unrecorded test file gets -- rather than a full run of the whole suite.
    const command = inventoryScript(VALID);
    const result = testInventoryChange({
      cwd: process.cwd(),
      config: { inventory: { command } },
      map: BASE_MAP, // no `testInventory`
    });
    expect(result?.fallOpen).toBeUndefined();
    expect(result?.mandatory).toEqual([
      { file: 'spec:features/agenda.md', name: 'scenario-1' },
      { file: 'spec:features/agenda.md', name: 'scenario-2' },
    ]);
    expect(result?.known).toHaveLength(2);
  });

  it('runs an id whose version differs from the one recorded', () => {
    const command = inventoryScript(VALID);
    const map: CoverageMap = {
      ...BASE_MAP,
      testInventory: {
        source: 'sha:aaa111',
        entries: [
          { id: { file: 'spec:features/agenda.md', name: 'scenario-1' }, version: 'v0' },
        ],
      },
    };
    const result = testInventoryChange({
      cwd: process.cwd(),
      config: { inventory: { command } },
      map,
    });
    expect(result?.mandatory).toEqual(
      expect.arrayContaining([{ file: 'spec:features/agenda.md', name: 'scenario-1' }]),
    );
  });

  it('leaves an id whose version has not moved out of the mandatory set', () => {
    const command = inventoryScript(VALID);
    const map: CoverageMap = {
      ...BASE_MAP,
      testInventory: {
        source: 'sha:aaa111',
        entries: [
          { id: { file: 'spec:features/agenda.md', name: 'scenario-1' }, version: 'v1' },
        ],
      },
    };
    const result = testInventoryChange({
      cwd: process.cwd(),
      config: { inventory: { command } },
      map,
    });
    const mandatoryFiles = result?.mandatory?.map((t) => t.name);
    expect(mandatoryFiles).not.toContain('scenario-1');
    // scenario-2 has no version, so it is never read as unchanged.
    expect(mandatoryFiles).toContain('scenario-2');
  });

  it('always runs an id with no version, however the map recorded it', () => {
    const command = inventoryScript(VALID);
    const map: CoverageMap = {
      ...BASE_MAP,
      testInventory: {
        source: 'sha:aaa111',
        entries: [{ id: { file: 'spec:features/agenda.md', name: 'scenario-2' } }],
      },
    };
    const result = testInventoryChange({
      cwd: process.cwd(),
      config: { inventory: { command } },
      map,
    });
    expect(result?.mandatory?.map((t) => t.name)).toContain('scenario-2');
  });

  it('is a full run, sentinel-style, when the source moved', () => {
    const command = inventoryScript(VALID);
    const map: CoverageMap = {
      ...BASE_MAP,
      testInventory: { source: 'sha:old000', entries: [] },
    };
    const result = testInventoryChange({
      cwd: process.cwd(),
      config: { inventory: { command } },
      map,
    });
    expect(result?.fallOpen).toContain('sha:old000');
    expect(result?.fallOpen).toContain('sha:aaa111');
  });

  it('drops an id the map recorded that the current inventory no longer names', () => {
    // Nothing here has to run because of a dropped id -- it simply is not in
    // `known`/`mandatory`, and the ordinary file-coverage axis is untouched.
    const command = inventoryScript(VALID);
    const map: CoverageMap = {
      ...BASE_MAP,
      testInventory: {
        source: 'sha:aaa111',
        entries: [
          { id: { file: 'spec:features/agenda.md', name: 'scenario-1' }, version: 'v1' },
          { id: { file: 'spec:features/removed.md', name: 'gone' }, version: 'v1' },
        ],
      },
    };
    const result = testInventoryChange({
      cwd: process.cwd(),
      config: { inventory: { command } },
      map,
    });
    expect(result?.known?.some((t) => t.file === 'spec:features/removed.md')).toBe(false);
    expect(result?.mandatory?.some((t) => t.file === 'spec:features/removed.md')).toBe(
      false,
    );
  });
});
