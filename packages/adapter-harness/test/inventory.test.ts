import { recordMap, resolveConfig } from '@covsel/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPerTestRecorder } from '../src/per-test-recorder.js';
import { resolveHarnessConfig } from '../src/config.js';
import { startInspectedApp, type InspectedApp } from './inspected-app.js';

/**
 * `recordMap` recording a scenario that is not a file in this repository at
 * all, through the real per-test recorder rather than a synthetic test
 * double -- the shape covsel/covsel#122's own motivating case needs, and
 * exactly what `Recorder.recordsInventoryIds` (declared by both of this
 * adapter's recorders) exists to unlock.
 */

let app: InspectedApp | undefined;

afterEach(() => {
  app?.child.kill();
  app = undefined;
});

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
