import { resolveConfig } from '@covsel/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPerTestRecorder } from '../src/per-test-recorder.js';
import { resolveHarnessConfig } from '../src/config.js';
import { startInspectedApp, type InspectedApp } from './inspected-app.js';

const config = resolveConfig({ granularity: 'file' });

let app: InspectedApp | undefined;

afterEach(() => {
  app?.child.kill();
  app = undefined;
});

describe('per-test recording fail-open behaviour', () => {
  it('declares recordsInventoryIds -- an id is whatever harness.run is handed, never a path this process reads', async () => {
    app = await startInspectedApp();
    const harness = resolveHarnessConfig({
      run: '--only {id}',
      server: { inspectUrl: app.inspectUrl, observes: ['**'] },
    });
    const rec = createPerTestRecorder({
      command: [process.execPath, '-e', 'process.exit(0)', '--'],
      cwd: app.cwd,
      config,
      harness,
    });
    expect(rec.recordsInventoryIds).toBe(true);
  }, 20_000);

  it('records a passing test', async () => {
    app = await startInspectedApp();
    const harness = resolveHarnessConfig({
      run: '--only {id}',
      server: { inspectUrl: app.inspectUrl, observes: ['**'] },
    });
    const rec = createPerTestRecorder({
      command: [process.execPath, '-e', 'process.exit(0)', '--'],
      cwd: app.cwd,
      config,
      harness,
    });
    const units = await rec.record?.('a.harness');
    expect(units).toHaveLength(1);
    expect(units?.[0]?.test.file).toBe('a.harness');
  }, 20_000);

  it('fails the recording when the harness exits non-zero', async () => {
    app = await startInspectedApp();
    const harness = resolveHarnessConfig({
      run: '--only {id}',
      server: { inspectUrl: app.inspectUrl, observes: ['**'] },
    });
    const rec = createPerTestRecorder({
      command: [process.execPath, '-e', 'process.exit(1)', '--'],
      cwd: app.cwd,
      config,
      harness,
    });
    await expect(rec.record?.('a.harness')).rejects.toThrow(/exited with/);
  }, 20_000);

  it('fails the recording when the inspector cannot be reached', async () => {
    app = await startInspectedApp();
    const harness = resolveHarnessConfig({
      run: '--only {id}',
      server: { inspectUrl: 'http://127.0.0.1:1', observes: ['**'] },
    });
    const rec = createPerTestRecorder({
      command: [process.execPath, '-e', 'process.exit(0)', '--'],
      cwd: app.cwd,
      config,
      harness,
    });
    await expect(rec.record?.('a.harness')).rejects.toThrow();
  }, 20_000);

  it('times out a hanging harness invocation rather than blocking covsel record forever', async () => {
    app = await startInspectedApp();
    const harness = resolveHarnessConfig({
      run: '--only {id}',
      server: { inspectUrl: app.inspectUrl, observes: ['**'] },
      testTimeoutMs: 200,
    });
    const rec = createPerTestRecorder({
      // Never exits on its own -- there is no cooperating harness in this
      // mode to time a single test out against, only the whole invocation,
      // so `harness.testTimeoutMs` is the only thing that can stop this.
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)', '--'],
      cwd: app.cwd,
      config,
      harness,
    });
    const start = Date.now();
    await expect(rec.record?.('a.harness')).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 20_000);

  describe('settleMs', () => {
    const DEFERRED_DELAY_MS = 100;

    /** See `boundary-server.test.ts`'s own copy of this for what it stands
     * in for: server work that keeps going, in a fresh script the mapper has
     * to be told about separately, after the harness invocation that
     * triggered it has already exited. */
    const DEFERRED_APP_SOURCE =
      'import { existsSync } from "node:fs";\n' +
      'setInterval(() => JSON.parse(\'{"a":1}\'), 5);\n' +
      'let fired = false;\n' +
      'const poll = setInterval(() => {\n' +
      '  if (fired || !existsSync("trigger")) return;\n' +
      '  fired = true;\n' +
      '  clearInterval(poll);\n' +
      `  setTimeout(() => { void import('./deferred.mjs'); }, ${DEFERRED_DELAY_MS});\n` +
      '}, 5);\n';

    async function recordWithSettle(settleMs: number | undefined): Promise<string[]> {
      const cwd = app!.cwd;
      writeFileSync(join(cwd, 'deferred.mjs'), 'export const ran = true;\n');
      const harness = resolveHarnessConfig({
        run: '--only {id}',
        server: {
          inspectUrl: app!.inspectUrl,
          observes: ['**'],
          ...(settleMs !== undefined ? { settleMs } : {}),
        },
      });
      const rec = createPerTestRecorder({
        // Writes the trigger and exits immediately -- the deferred work
        // happens strictly after this invocation is already done.
        command: [
          process.execPath,
          '-e',
          "require('node:fs').writeFileSync('trigger', 'go')",
          '--',
        ],
        cwd,
        config,
        harness,
      });
      const units = await rec.record?.('a.harness');
      return units?.[0]?.files.map((f) => f.file) ?? [];
    }

    it('attributes work that finishes within settleMs of the invocation exiting', async () => {
      app = await startInspectedApp(DEFERRED_APP_SOURCE);
      const files = await recordWithSettle(DEFERRED_DELAY_MS * 3);
      expect(files).toContain('deferred.mjs');
    }, 20_000);

    it('omits that same work when settleMs is unset -- no regression on today’s behaviour', async () => {
      app = await startInspectedApp(DEFERRED_APP_SOURCE);
      const files = await recordWithSettle(undefined);
      expect(files).not.toContain('deferred.mjs');
    }, 20_000);
  });
});
