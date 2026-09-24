import { resolveConfig } from '@covsel/core';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createBoundaryRecorder } from '../src/boundary-server.js';
import { resolveHarnessConfig } from '../src/config.js';
import { KILL_GRACE_MS } from '../src/spawn-detached.js';
import { startInspectedApp, type InspectedApp } from './inspected-app.js';

const DANGLING_HANDLE_FIXTURE = fileURLToPath(
  new URL('./fixtures/dangling-handle-check.mjs', import.meta.url),
);
const PENDING_BEGIN_RACE_FIXTURE = fileURLToPath(
  new URL('./fixtures/pending-begin-race-check.mjs', import.meta.url),
);

/** Spawn `fixture` with `[inspectUrl, cwd]` and resolve once it exits on its
 * own, or reject once `boundMs` passes without that -- used by both
 * dangling-handle checks below, which differ only in which fixture and what
 * they additionally assert once the process has actually exited. */
async function runDanglingHandleFixture(
  fixture: string,
  inspectUrl: string,
  cwd: string,
  boundMs: number,
): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, [fixture, inspectUrl, cwd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c));
  child.stderr.on('data', (c: Buffer) => {
    // Surfaced for a human debugging a failure here, never asserted on --
    // this check cares only about whether the process exits, not what it
    // prints along the way.
    process.stderr.write(c);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });
  // A safety net for the test itself, not the assertion -- without it, a
  // regression here would hang this test (and the whole suite) rather than
  // failing it.
  let killed = false;
  const killer = setTimeout(() => {
    killed = true;
    child.kill('SIGKILL');
  }, boundMs);
  const start = Date.now();
  const code = await exited;
  clearTimeout(killer);
  if (killed) {
    throw new Error(
      `${fixture} did not exit on its own within ${boundMs}ms -- something is ` +
        'still keeping its process alive.',
    );
  }
  expect(Date.now() - start).toBeLessThan(boundMs);
  return { code, stdout };
}

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
    // Well under `testTimeoutMs`'s ten-minute default. This alone does not
    // prove the session was actually closed, only that *something* let this
    // promise settle -- vitest's own process has plenty else keeping its
    // event loop alive regardless, so a leaked handle right here would not
    // show up as a hang. The check below, in a process with nothing else of
    // its own to stay alive for, is what actually proves that.
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 20_000);

  it('leaves nothing dangling: a real process running recordRun exits on its own after the harness exits mid-test', async () => {
    app = await startInspectedApp();
    // A separate OS process, not vitest's own -- see `dangling-handle-check`'s
    // own doc comment for why only this actually proves the B4 regression
    // (`covsel record` never exiting) rather than a proxy for it.
    const { code, stdout } = await runDanglingHandleFixture(
      DANGLING_HANDLE_FIXTURE,
      app.inspectUrl,
      app.cwd,
      8_000,
    );
    expect(stdout).toMatch(/recordRun rejected as expected/);
    expect(code).toBe(0);
  }, 20_000);

  it('does not resurrect an open window and watchdog when the harness exits while /begin’s own coverage window is still opening', async () => {
    app = await startInspectedApp();
    // See `pending-begin-race-check.mjs`'s own doc comment for the race this
    // reproduces and why it needs a real, separate process to prove: before
    // the fix, `handleBegin` resurrects a live session and a fresh watchdog
    // well after `recordRun` has already returned, and only a process with
    // nothing else of its own to stay alive for can show that either one
    // would keep it running.
    const { code, stdout } = await runDanglingHandleFixture(
      PENDING_BEGIN_RACE_FIXTURE,
      app.inspectUrl,
      app.cwd,
      3_000,
    );
    expect(stdout).toMatch(/recordRun rejected as expected/);
    expect(code).toBe(0);
  }, 20_000);

  it('rejects a request to a path without the recording’s own token, and fails the recording so the rejection is not silently lost', async () => {
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
    // The request itself is still rejected (the harness script's own exit
    // code, checked above via its process exit, proves that) -- but a
    // request that carries no valid token at all is not something a
    // cooperating harness ever legitimately sends, so it now names the whole
    // recording untrustworthy rather than being silently swallowed.
    await expect(rec.recordRun!([])).rejects.toThrow(/boundary protocol was violated/);
  }, 20_000);

  it('rejects a request with the wrong content-type, and fails the recording so the rejection is not silently lost', async () => {
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
    await expect(rec.recordRun!([])).rejects.toThrow(/boundary protocol was violated/);
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
        `${POST_HELPER}` +
          // "a" is begun and still open when "end" names a DIFFERENT test --
          // the actual mismatch this test exists to exercise, not merely "no
          // test was open at all" (which the "no matching open test" branch
          // would also satisfy trivially, without ever exercising this path).
          `post('/begin',{id:'a'})` +
          `.then(()=>post('/end',{id:'b',outcome:'passed'}));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    // Names which test was actually open ("a"), not just that "b" did not
    // match -- the whole point of a mismatch error over a generic "nothing
    // was open" one.
    await expect(rec.recordRun!([])).rejects.toThrow(/no matching open test \(a was\)/);
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

  it('escalates to SIGKILL, after KILL_GRACE_MS, when a stuck harness ignores SIGTERM', async () => {
    app = await startInspectedApp();
    const { harness, config: cfg } = recorder(app.inspectUrl, { testTimeoutMs: 200 });
    const pidFile = join(app.cwd, 'harness.pid');
    const rec = createBoundaryRecorder({
      command: miniHarness(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
          // Traps SIGTERM and does nothing with it -- only SIGKILL can stop
          // this process, so its actually exiting is only possible through
          // the escalation this test exists to prove fires at all.
          `process.on('SIGTERM',()=>{});` +
          `${POST_HELPER}` +
          `post('/begin',{id:'a'}).then(()=>setInterval(()=>{},1000));`,
      ),
      cwd: app.cwd,
      config: cfg,
      harness,
    });
    const start = Date.now();
    await expect(rec.recordRun!([])).rejects.toThrow(/did not report "end"/);
    const elapsed = Date.now() - start;
    // `recordRun` cannot settle until the harness process actually exits --
    // and with SIGTERM ignored, the only way that happens is the escalation
    // to SIGKILL after `KILL_GRACE_MS`. Settling at all, and only after
    // roughly that long, is what proves the escalation fired rather than the
    // harness exiting some other way (which a SIGTERM-only kill, wrongly
    // never escalating, would just hang on -- and this test's own 20s bound
    // would catch that as a timeout instead).
    expect(elapsed).toBeGreaterThanOrEqual(KILL_GRACE_MS);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(isProcessGone(pid)).toBe(true);
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
