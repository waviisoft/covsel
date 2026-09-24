import { resolveConfig } from '@covsel/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** `post(path, body)` inside a `miniHarness` script -- every request needs the
 * `content-type` header the server now requires. */
const POST_HELPER =
  'const __b=process.env.COVSEL_BOUNDARY;' +
  'function post(path,body){' +
  "return fetch(__b+path,{method:'POST'," +
  "headers:{'content-type':'application/json'}," +
  'body:JSON.stringify(body)});' +
  '}';

/** True once `pid` has actually stopped running -- including a zombie that a
 * sandbox with no reaper never collects, since a zombie has already been
 * killed even though its pid is not yet freed. */
function isProcessGone(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return true;
  }
  const afterName = stat.slice(stat.lastIndexOf(')') + 2);
  return afterName.split(' ')[0] === 'Z';
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition never became true');
}

describe('boundary protocol fail-open behaviour', () => {
  it('declares recordsInventoryIds -- an id is whatever the harness posts, never a path this process reads', () => {
    const { harness, config: cfg } = recorder('http://127.0.0.1:1');
    const rec = createBoundaryRecorder({
      command: [process.execPath, '-e', 'process.exit(0)'],
      cwd: '.',
      config: cfg,
      harness,
    });
    expect(rec.recordsInventoryIds).toBe(true);
  });

  it('drops a failed test rather than recording it as covering nothing', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `${POST_HELPER}` +
          `post('/begin',{id:'a'})` +
          `.then(()=>post('/end',{id:'a',outcome:'failed'}));`,
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
        `${POST_HELPER}` +
          `post('/begin',{id:'a'})` +
          `.then(()=>new Promise((r)=>setTimeout(r,50)))` +
          `.then(()=>post('/end',{id:'a',outcome:'passed'}));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    const units = await rec.recordRun!([]);
    expect(units).toHaveLength(1);
    expect(units[0]?.test.file).toBe('a');
  }, 20_000);

  it('records a skipped test as covering nothing, never the window it happened to sit in', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `${POST_HELPER}` +
          // Real server work happens during this window -- the inspected
          // app's own background `setInterval` guarantees something would be
          // recorded if the mapper ran on it -- and outcome is still
          // "skipped": the unit has to come back empty regardless.
          `post('/begin',{id:'a'})` +
          `.then(()=>new Promise((r)=>setTimeout(r,50)))` +
          `.then(()=>post('/end',{id:'a',outcome:'skipped'}));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    const units = await rec.recordRun!([]);
    expect(units).toHaveLength(1);
    expect(units[0]?.test.file).toBe('a');
    expect(units[0]?.files).toEqual([]);
    expect(units[0]?.blocks).toEqual([]);
  }, 20_000);

  it('fails the whole recording when a begin overlaps an open test', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `${POST_HELPER}` + `post('/begin',{id:'a'}).then(()=>post('/begin',{id:'b'}));`,
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
      command: miniHarness(`${POST_HELPER}post('/begin',{id:'a'});`),
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
        `${POST_HELPER}post('/begin',{id:'a'}).then(()=>setInterval(()=>{},1000));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    await expect(rec.recordRun!([])).rejects.toThrow(/did not report "end"/);
  }, 20_000);

  it('closes the coverage session and settles promptly when the harness exits cleanly while a test is still open', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      // Reports "begin" and then exits 0 without ever reporting "end" -- not
      // a hang the watchdog has to catch, a harness that (incorrectly)
      // thinks it is done.
      command: miniHarness(`${POST_HELPER}post('/begin',{id:'a'});`),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    const start = Date.now();
    await expect(rec.recordRun!([])).rejects.toThrow(/still open/);
    // Well under `testTimeoutMs`'s ten-minute default -- if the session the
    // harness left open were never closed, nothing here would still prove a
    // hang (the promise above already resolved), but this is the same shape
    // of check `covsel record`'s own process exit would fail if a leaked
    // handle kept the event loop alive.
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 20_000);

  it('rejects a request to a path without the recording’s own token', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `const u=new URL(process.env.COVSEL_BOUNDARY);` +
          `fetch(u.protocol+'//'+u.host+'/begin',{method:'POST',` +
          `headers:{'content-type':'application/json'},body:JSON.stringify({id:'a'})})` +
          `.then((r)=>process.exit(r.status===404?0:1));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    await expect(rec.recordRun!([])).resolves.toEqual([]);
  }, 20_000);

  it('rejects a request with the wrong content-type', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `const b=process.env.COVSEL_BOUNDARY;` +
          `fetch(b+'/begin',{method:'POST',headers:{'content-type':'text/plain'},` +
          `body:JSON.stringify({id:'a'})})` +
          `.then((r)=>process.exit(r.status===400?0:1));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    await expect(rec.recordRun!([])).resolves.toEqual([]);
  }, 20_000);

  it('binds to loopback only, never 0.0.0.0 or an unbound host', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const boundaryFile = join(app.cwd, 'boundary-url.txt');
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `require('node:fs').writeFileSync(${JSON.stringify(boundaryFile)},` +
          `process.env.COVSEL_BOUNDARY);`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    await rec.recordRun!([]);
    const boundaryUrl = readFileSync(boundaryFile, 'utf8');
    expect(new URL(boundaryUrl).hostname).toBe('127.0.0.1');
  }, 20_000);

  it('accepts only one of two concurrent /begin calls for different tests', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const raceFile = join(app.cwd, 'race-result.json');
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `${POST_HELPER}` +
          // No `await` between the two -- they are in flight at the same
          // time, which is the race this exists to close.
          `Promise.all([post('/begin',{id:'a'}),post('/begin',{id:'b'})])` +
          `.then(([r1,r2])=>{` +
          `const results=[{id:'a',ok:r1.ok},{id:'b',ok:r2.ok}];` +
          `require('node:fs').writeFileSync(${JSON.stringify(raceFile)},JSON.stringify(results));` +
          `return Promise.all([` +
          `r1.ok?post('/end',{id:'a',outcome:'passed'}):Promise.resolve(),` +
          `r2.ok?post('/end',{id:'b',outcome:'passed'}):Promise.resolve(),` +
          `]);` +
          `});`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    // A `/begin` overlapping another open test always fails the whole
    // recording, by design -- that part is expected and true whether the
    // race is closed correctly or not. What this test actually proves is in
    // the marker file: with the reservation in place, exactly one of the two
    // concurrent calls is ever told it opened a window; without it, both
    // could be.
    await expect(rec.recordRun!([])).rejects.toThrow(/still open/);
    const results = JSON.parse(readFileSync(raceFile, 'utf8')) as {
      id: string;
      ok: boolean;
    }[];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  }, 20_000);

  it('fails the recording, naming the mismatch, when /end names a test that is not the one open', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl);
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `${POST_HELPER}post('/end',{id:'not-open',outcome:'passed'});`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    await expect(rec.recordRun!([])).rejects.toThrow(/no matching open test/);
  }, 20_000);

  it('kills a stuck harness’s whole process tree, not just the process it spawned directly', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl, { testTimeoutMs: 200 });
    const childPidFile = join(app.cwd, 'child.pid');
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `const {spawn}=require('node:child_process');` +
          `const c=spawn('sleep',['30'],{stdio:'ignore'});` +
          `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)},String(c.pid));` +
          `${POST_HELPER}` +
          // begin, then hang forever without ending -- the watchdog has to
          // fire, and killing this process alone would leave `sleep` behind.
          `post('/begin',{id:'a'}).then(()=>setInterval(()=>{},1000));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    await expect(rec.recordRun!([])).rejects.toThrow(/did not report "end"/);
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    await waitUntil(() => isProcessGone(childPid), 5_000);
  }, 20_000);

  describe('settleMs', () => {
    const DEFERRED_DELAY_MS = 100;

    /** An app that only executes `deferred.mjs` -- a fresh source file, so
     * its execution shows up as a new script the mapper has to be told about
     * separately -- once a trigger file appears in its own `cwd`, and only
     * after `DEFERRED_DELAY_MS` more. Standing in for a server's own
     * fire-and-forget work that keeps going after it has already answered
     * the client. */
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
        boundary: {},
      });
      const rec = createBoundaryRecorder({
        command: miniHarness(
          `${POST_HELPER}` +
            `post('/begin',{id:'a'})` +
            `.then(()=>require('node:fs').writeFileSync('trigger','go'))` +
            `.then(()=>post('/end',{id:'a',outcome:'passed'}));`,
        ),
        cwd,
        config,
        harness,
      });
      const units = await rec.recordRun!([]);
      return units[0]?.files.map((f) => f.file) ?? [];
    }

    it('attributes work that finishes within settleMs of the window closing', async () => {
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
