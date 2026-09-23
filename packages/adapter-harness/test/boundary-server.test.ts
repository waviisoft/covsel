import { resolveConfig } from '@covsel/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createBoundaryRecorder } from '../src/boundary-server.js';
import { resolveHarnessConfig } from '../src/config.js';
import { startInspectedApp, type InspectedApp } from './inspected-app.js';

/**
 * The fail-open properties the boundary protocol promises, exercised against
 * a real inspector and a real (tiny, inline) harness process for each one --
 * the conformance suite covers the happy path for both recording modes, and
 * this covers what happens when a harness misbehaves.
 */

const config = resolveConfig({ granularity: 'file' });

let app: InspectedApp | undefined;

afterEach(() => {
  app?.child.kill();
  app = undefined;
});

function recorder(inspectUrl: string, boundaryOverrides: Record<string, unknown> = {}) {
  const harness = resolveHarnessConfig({
    run: '--only {id}',
    server: { inspectUrl, observes: ['**'] },
    boundary: boundaryOverrides,
  });
  return { harness, config };
}

/** A harness that speaks the boundary protocol directly, via one inline script. */
function miniHarness(script: string): string[] {
  return [process.execPath, '-e', script];
}

describe('boundary protocol fail-open behaviour', () => {
  it('drops a failed test rather than recording it as covering nothing', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `const b=process.env.COVSEL_BOUNDARY;` +
          `fetch(b+'/begin',{method:'POST',body:JSON.stringify({id:'a'})})` +
          `.then(()=>fetch(b+'/end',{method:'POST',body:JSON.stringify({id:'a',outcome:'failed'})}));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    const units = await rec.recordRun!([]);
    expect(units).toEqual([]);
  }, 20_000);

  it('records a passed test normally', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `const b=process.env.COVSEL_BOUNDARY;` +
          `fetch(b+'/begin',{method:'POST',body:JSON.stringify({id:'a'})})` +
          `.then(()=>new Promise((r)=>setTimeout(r,50)))` +
          `.then(()=>fetch(b+'/end',{method:'POST',body:JSON.stringify({id:'a',outcome:'passed'})}));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    const units = await rec.recordRun!([]);
    expect(units).toHaveLength(1);
    expect(units[0]?.test.file).toBe('a');
  }, 20_000);

  it('fails the whole recording when a begin overlaps an open test', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `const b=process.env.COVSEL_BOUNDARY;` +
          `fetch(b+'/begin',{method:'POST',body:JSON.stringify({id:'a'})})` +
          `.then(()=>fetch(b+'/begin',{method:'POST',body:JSON.stringify({id:'b'})}));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    await expect(rec.recordRun!([])).rejects.toThrow(/still open/);
  }, 20_000);

  it('fails the whole recording when the inspector cannot be reached', async () => {
    app = await startInspectedApp();
    // Port 1 is never a real inspector -- the same unreachable target
    // `RemoteCoverageSession`'s own tests use.
    const { harness, config: cfg } = recorder('http://127.0.0.1:1');
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `const b=process.env.COVSEL_BOUNDARY;` +
          `fetch(b+'/begin',{method:'POST',body:JSON.stringify({id:'a'})});`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    await expect(rec.recordRun!([])).rejects.toThrow(/boundary protocol was violated/);
  }, 20_000);

  it('kills a stuck harness and fails the recording rather than hanging forever', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl, { testTimeoutMs: 200 });
    const rec = createBoundaryRecorder({
      command: miniHarness(
        // begin("a"), then never send "end" -- and never exit on its own either.
        `const b=process.env.COVSEL_BOUNDARY;` +
          `fetch(b+'/begin',{method:'POST',body:JSON.stringify({id:'a'})})` +
          `.then(()=>setInterval(()=>{},1000));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    await expect(rec.recordRun!([])).rejects.toThrow(/did not report "end"/);
  }, 20_000);
});
