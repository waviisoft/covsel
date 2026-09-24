import { recordMap, resolveConfig, selectAffected } from '@covsel/core';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPerTestRecorder } from '../src/per-test-recorder.js';
import { resolveHarnessConfig } from '../src/config.js';
import { startInspectedApp, type InspectedApp } from './inspected-app.js';

/**
 * `recordMap` recording a scenario that is not a file in this repository at
 * all, through the real per-test recorder rather than a synthetic test
 * double -- the ordinary shape for an acceptance suite whose scenarios are
 * pinned from another repository or a test-management system, never files
 * here, and exactly what `Recorder.recordsInventoryIds` (declared by both of
 * this adapter's recorders) exists to unlock.
 */

let app: InspectedApp | undefined;

afterEach(() => {
  app?.child.kill();
  app = undefined;
});

/** Run git in `cwd`, throwing on failure -- selection reads a diff, so
 * exercising it for real needs a real work tree. The developer's own git
 * configuration is pinned out so a local `init.defaultBranch`, hooks, or
 * signing settings cannot change what this measures. */
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

describe('recording a suite that is entirely inventory-defined', () => {
  it('records a virtual id, with no file matching testGlobs at all', async () => {
    app = await startInspectedApp();
    const inventoryScript = join(app.cwd, 'inventory.cjs');
    writeFileSync(
      inventoryScript,
      'process.stdout.write(JSON.stringify({' +
        '"source":"test-harness",' +
        '"entries":[{"id":{"file":"spec:only-a-virtual-id"}}]' +
        '}));\n',
    );
    const config = resolveConfig({
      granularity: 'file',
      // Matches nothing on disk, on purpose -- `app.cwd` holds only `app.mjs`.
      testGlobs: ['test/**/*.test.mjs'],
      inventory: { command: `node ${JSON.stringify(inventoryScript)}` },
      harness: {
        run: '--only {id}',
        server: { inspectUrl: app.inspectUrl, observes: ['**'] },
      },
    });
    const harness = resolveHarnessConfig(config.harness);
    const recorder = createPerTestRecorder({
      command: [process.execPath, '-e', 'process.exit(0)', '--'],
      cwd: app.cwd,
      config,
      harness,
    });

    const result = await recordMap({ cwd: app.cwd, config, recorder });

    expect(result.ok).toBe(true);
    expect(result.map?.entries.map((e) => e.test.file)).toEqual([
      'spec:only-a-virtual-id',
    ]);
  }, 20_000);
});

describe('selecting within a suite that is entirely inventory-defined', () => {
  it('narrows correctly with zero testGlobs-matching files, not just one virtual scenario mixed into an otherwise file-based suite', async () => {
    app = await startInspectedApp();
    const inventoryScript = join(app.cwd, 'inventory.cjs');
    writeFileSync(
      inventoryScript,
      'process.stdout.write(JSON.stringify({' +
        '"source":"test-harness",' +
        '"entries":[{"id":{"file":"spec:only-a-virtual-id"},' +
        '"version":process.env.INVENTORY_TEST_VERSION||"v1"}]' +
        '}));\n',
    );
    git(app.cwd, ['init', '-q', '-b', 'main']);
    git(app.cwd, ['config', 'user.email', 'test@example.com']);
    git(app.cwd, ['config', 'user.name', 'covsel test']);
    git(app.cwd, ['add', '.']);
    git(app.cwd, ['commit', '-q', '-m', 'fixture']);

    const config = resolveConfig({
      granularity: 'file',
      // Matches nothing on disk, on purpose -- this suite is entirely
      // inventory-defined, with no anchor file for any scenario at all.
      testGlobs: ['nomatch/**/*.test.mjs'],
      inventory: { command: `node ${JSON.stringify(inventoryScript)}` },
      harness: {
        run: '--only {id}',
        server: { inspectUrl: app.inspectUrl, observes: ['**'] },
      },
    });
    const harness = resolveHarnessConfig(config.harness);
    const recorder = createPerTestRecorder({
      command: [process.execPath, '-e', 'process.exit(0)', '--'],
      cwd: app.cwd,
      config,
      harness,
    });

    const recorded = await recordMap({ cwd: app.cwd, config, recorder });
    expect(recorded.ok).toBe(true);

    const unchanged = await selectAffected({ cwd: app.cwd, config });
    expect(unchanged.fullRun).toBe(false);
    expect(unchanged.selected).toEqual([]);

    const previousVersion = process.env.INVENTORY_TEST_VERSION;
    process.env.INVENTORY_TEST_VERSION = 'v2';
    try {
      const bumped = await selectAffected({ cwd: app.cwd, config });
      expect(bumped.fullRun).toBe(false);
      expect(bumped.selected.map((t) => t.file)).toEqual(['spec:only-a-virtual-id']);
    } finally {
      if (previousVersion === undefined) delete process.env.INVENTORY_TEST_VERSION;
      else process.env.INVENTORY_TEST_VERSION = previousVersion;
    }
  }, 20_000);
});
