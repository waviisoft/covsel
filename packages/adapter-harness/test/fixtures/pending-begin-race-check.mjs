/**
 * Run for real, in a process of its own, by `boundary-server.test.ts`'s
 * "does not resurrect an open window" check -- the same reason
 * `dangling-handle-check.mjs` runs in its own process rather than inside this
 * check's own vitest worker (see that fixture's own doc comment): only a
 * process with nothing else of its own to stay alive for can prove that
 * nothing here left a handle open.
 *
 * Reproduces the race `handleBegin` used to lose: the harness posts "begin"
 * and exits almost immediately, without waiting for the response, while
 * `RemoteCoverageSession.start()` -- gated here, standing in for the
 * reviewer's own repro (an inspector whose `/json/list` answers late) -- is
 * still opening the coverage window `/begin` promised. `recordRun` itself
 * settles well before the gate releases, independent of that still-pending
 * `await`; what this process additionally has to survive is the moment the
 * gate *does* release, after `recordRun` has already returned. Before the
 * fix, `handleBegin` would resurrect a live session and a fresh watchdog
 * right there regardless -- and either one keeps a process alive on its own.
 *
 * argv: [inspectUrl, cwd]
 */
import { adapter } from '../../dist/index.js';
import { resolveConfig } from '@covsel/core';

const [, , inspectUrl, cwd] = process.argv;

/** Long enough that the harness (see below) has certainly already exited by
 * the time this releases -- short enough this check does not itself take
 * long to run. */
const GATE_DELAY_MS = 200;

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url === `${inspectUrl}/json/list`) {
    return new Promise((resolve) => setTimeout(resolve, GATE_DELAY_MS)).then(() =>
      originalFetch(input, init),
    );
  }
  return originalFetch(input, init);
};

const config = resolveConfig({
  granularity: 'file',
  harness: {
    run: '--only {id}',
    server: { inspectUrl, observes: ['**'] },
    // Deliberately much longer than this check's own bound on the parent
    // side: if the fix regresses and a watchdog gets resurrected on this
    // timer, the parent test has to still be waiting on this process well
    // before that watchdog would ever fire and clean up after itself --
    // otherwise a self-healing leak could pass this check by accident.
    boundary: { testTimeoutMs: 5_000 },
  },
});

/** `post(path, body)`, exactly as `boundary-server.test.ts`'s own
 * `POST_HELPER` miniHarness scripts use it. */
const POST_HELPER =
  'const __b=process.env.COVSEL_BOUNDARY;' +
  'function post(path,body){' +
  "return fetch(__b+path,{method:'POST'," +
  "headers:{'content-type':'application/json'}," +
  'body:JSON.stringify(body)});' +
  '}';

const recorder = adapter.createRecorder({
  command: [
    process.execPath,
    '-e',
    // Fires "begin" without waiting for the response, then exits almost at
    // once -- well before `GATE_DELAY_MS` above lets `session.start()`
    // resolve inside `handleBegin`.
    `${POST_HELPER}post('/begin',{id:'a'});setTimeout(()=>process.exit(0),20);`,
  ],
  cwd,
  config,
});

try {
  await recorder.recordRun([]);
  console.log('unexpected: recordRun resolved instead of rejecting');
} catch (err) {
  console.log(`recordRun rejected as expected: ${err.message}`);
}

// Deliberately no `process.exit()` here -- see `dangling-handle-check.mjs`'s
// own doc comment for what that proves. This process additionally has to
// outlive the gate above releasing, `GATE_DELAY_MS` after "begin", with
// nothing keeping it alive at that point either.
