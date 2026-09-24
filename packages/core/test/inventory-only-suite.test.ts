import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { git, write } from './helpers/repo.js';
import {
  createGenericRecorder,
  OBSERVES_EVERYTHING,
  recordMap,
  type CovselConfig,
  type Recorder,
  type RecordedUnit,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * A suite that is entirely inventory-defined -- every scenario a virtual id,
 * none a file `testGlobs` matches at all. This is the ordinary shape for an
 * acceptance suite an external harness drives, whose scenarios live in
 * another repository or a test-management system rather than as files here:
 * `recordMap`/`selectAffected` used to refuse outright, before ever
 * consulting the inventory, whenever `discoverTestFiles` found nothing.
 *
 * The fix is gated behind `Recorder.recordsInventoryIds`, never automatic:
 * the last test below is the control proving a recorder that does not declare
 * it still gets today's honest refusal, rather than being handed a virtual id
 * it would pass straight to a runner expecting a real file.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A shell command covsel can run as `inventory.command`, printing fixed JSON. */
function inventoryCommand(inventory: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-invonly-cmd-'));
  dirs.push(dir);
  const path = join(dir, 'inventory.cjs');
  writeFileSync(
    path,
    `process.stdout.write(${JSON.stringify(JSON.stringify(inventory))});\n`,
  );
  return `node ${JSON.stringify(path)}`;
}

/** A recorder driven entirely by an inventory: every id it is handed is
 * virtual, resolved against a fixed scenario -> source map, exactly like the
 * harness adapter's own per-test recorder resolving an id through
 * `harness.run.expand([id])` rather than reading it as a path. */
function scenarioRecorder(covers: Record<string, string>): Recorder {
  return {
    observes: OBSERVES_EVERYTHING,
    recordsInventoryIds: true,
    async record(testFile: string): Promise<RecordedUnit[]> {
      const source = covers[testFile];
      if (source === undefined) {
        throw new Error(`no fixture coverage declared for ${testFile}`);
      }
      return [
        {
          test: { file: testFile },
          files: [{ file: source, fileHash: `sha256:${source}` }],
          blocks: [],
        },
      ];
    },
  };
}

/** A repository with two sources and no test files at all -- `testGlobs`
 * matches nothing on disk, on purpose. */
function fixture(): { cwd: string; config: (command: string) => CovselConfig } {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-invonly-'));
  dirs.push(cwd);
  write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
  write(cwd, 'src/a.mjs', 'export const a = 1;\n');
  write(cwd, 'src/b.mjs', 'export const b = 2;\n');
  write(cwd, '.gitignore', '.covsel/\n');
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'covsel test']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'fixture']);
  const config = (command: string): CovselConfig =>
    resolveConfig({
      sourceGlobs: ['src/**'],
      testGlobs: ['test/**/*.test.mjs'],
      inventory: { command },
    });
  return { cwd, config };
}

const HARNESS_V1 = 'sha:harness111';
const HARNESS_V2 = 'sha:harness222';

describe('a suite with no test files matching testGlobs at all', () => {
  it('records purely from the inventory, given an opted-in recorder', async () => {
    const { cwd, config: makeConfig } = fixture();
    const config = makeConfig(
      inventoryCommand({
        source: HARNESS_V1,
        entries: [
          { id: { file: 'spec:a' }, version: 'v1' },
          { id: { file: 'spec:b' }, version: 'v1' },
        ],
      }),
    );
    const recorder = scenarioRecorder({ 'spec:a': 'src/a.mjs', 'spec:b': 'src/b.mjs' });

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(true);
    expect(result.recorded).toBe(2);
    expect(result.map?.entries.map((e) => e.test.file).sort()).toEqual([
      'spec:a',
      'spec:b',
    ]);
  });

  it('selects only the scenario whose own version changed, not the whole suite', async () => {
    const { cwd, config: makeConfig } = fixture();
    const recorded = await recordMap({
      cwd,
      config: makeConfig(
        inventoryCommand({
          source: HARNESS_V1,
          entries: [
            { id: { file: 'spec:a' }, version: 'v1' },
            { id: { file: 'spec:b' }, version: 'v1' },
          ],
        }),
      ),
      recorder: scenarioRecorder({ 'spec:a': 'src/a.mjs', 'spec:b': 'src/b.mjs' }),
    });
    expect(recorded.ok).toBe(true);

    const config = makeConfig(
      inventoryCommand({
        source: HARNESS_V1,
        entries: [
          { id: { file: 'spec:a' }, version: 'v2' },
          { id: { file: 'spec:b' }, version: 'v1' },
        ],
      }),
    );
    const affected = await selectAffected({ cwd, config });

    expect(affected.fullRun).toBe(false);
    expect(affected.tests).toEqual(['spec:a']);
  });

  it('leaves an unchanged, uncovered scenario unselected', async () => {
    const { cwd, config: makeConfig } = fixture();
    const inv = {
      source: HARNESS_V1,
      entries: [
        { id: { file: 'spec:a' }, version: 'v1' },
        { id: { file: 'spec:b' }, version: 'v1' },
      ],
    };
    const recorded = await recordMap({
      cwd,
      config: makeConfig(inventoryCommand(inv)),
      recorder: scenarioRecorder({ 'spec:a': 'src/a.mjs', 'spec:b': 'src/b.mjs' }),
    });
    expect(recorded.ok).toBe(true);

    // Nothing moved: no source edited, no version bumped, no id added.
    const affected = await selectAffected({
      cwd,
      config: makeConfig(inventoryCommand(inv)),
    });

    expect(affected.fullRun).toBe(false);
    expect(affected.tests).toEqual([]);
  });

  it('selects a scenario whose covered source changed, via the ordinary diff', async () => {
    const { cwd, config: makeConfig } = fixture();
    const inv = {
      source: HARNESS_V1,
      entries: [
        { id: { file: 'spec:a' }, version: 'v1' },
        { id: { file: 'spec:b' }, version: 'v1' },
      ],
    };
    const recorded = await recordMap({
      cwd,
      config: makeConfig(inventoryCommand(inv)),
      recorder: scenarioRecorder({ 'spec:a': 'src/a.mjs', 'spec:b': 'src/b.mjs' }),
    });
    expect(recorded.ok).toBe(true);

    writeFileSync(join(cwd, 'src', 'a.mjs'), 'export const a = 2;\n');

    const affected = await selectAffected({
      cwd,
      config: makeConfig(inventoryCommand(inv)),
    });

    expect(affected.fullRun).toBe(false);
    expect(affected.tests).toEqual(['spec:a']);
  });

  it('runs a new id the inventory adds, never seen at recording time', async () => {
    const { cwd, config: makeConfig } = fixture();
    const recorded = await recordMap({
      cwd,
      config: makeConfig(
        inventoryCommand({
          source: HARNESS_V1,
          entries: [{ id: { file: 'spec:a' }, version: 'v1' }],
        }),
      ),
      recorder: scenarioRecorder({ 'spec:a': 'src/a.mjs' }),
    });
    expect(recorded.ok).toBe(true);

    const affected = await selectAffected({
      cwd,
      config: makeConfig(
        inventoryCommand({
          source: HARNESS_V1,
          entries: [
            { id: { file: 'spec:a' }, version: 'v1' },
            { id: { file: 'spec:b' }, version: 'v1' },
          ],
        }),
      ),
    });

    expect(affected.fullRun).toBe(false);
    expect(affected.tests).toEqual(['spec:b']);
  });

  it('runs the whole suite, naming every current id, when the harness identity moves', async () => {
    const { cwd, config: makeConfig } = fixture();
    const recorded = await recordMap({
      cwd,
      config: makeConfig(
        inventoryCommand({
          source: HARNESS_V1,
          entries: [
            { id: { file: 'spec:a' }, version: 'v1' },
            { id: { file: 'spec:b' }, version: 'v1' },
          ],
        }),
      ),
      recorder: scenarioRecorder({ 'spec:a': 'src/a.mjs', 'spec:b': 'src/b.mjs' }),
    });
    expect(recorded.ok).toBe(true);

    const affected = await selectAffected({
      cwd,
      config: makeConfig(
        inventoryCommand({
          source: HARNESS_V2,
          entries: [
            { id: { file: 'spec:a' }, version: 'v1' },
            { id: { file: 'spec:b' }, version: 'v1' },
          ],
        }),
      ),
    });

    expect(affected.fullRun).toBe(true);
    expect(affected.tests.sort()).toEqual(['spec:a', 'spec:b']);
  });

  it('is refused for a recorder that never declared it can record a virtual id', async () => {
    const { cwd, config: makeConfig } = fixture();
    const config = makeConfig(
      inventoryCommand({
        source: HARNESS_V1,
        entries: [{ id: { file: 'spec:a' }, version: 'v1' }],
      }),
    );
    // The generic adapter hands its runner a file argument it expects to
    // exist on disk, and does not declare `recordsInventoryIds` -- so this
    // must fail exactly as it did before this suite existed at all, rather
    // than being handed `spec:a` to run as if it were a file.
    const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no test files matched/);
    // Names the real blocker -- an inventory the recorder cannot use -- rather
    // than only sending someone to check `testGlobs` for a typo it does not have.
    expect(result.error).toMatch(/recordsInventoryIds/);
  });
});
