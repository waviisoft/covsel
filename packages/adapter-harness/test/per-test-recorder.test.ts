import { resolveConfig } from '@covsel/core';
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
});
