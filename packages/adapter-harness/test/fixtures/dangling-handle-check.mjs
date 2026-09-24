/**
 * Run for real, in a process of its own, by `boundary-server.test.ts`'s
 * "leaves nothing dangling" check -- proving the actual regression (a
 * `covsel record` process that never exits) rather than a proxy for it. The
 * parent test's own event loop always has other things keeping it alive
 * (vitest itself, the timers it sets to bound the check), so asserting only
 * that `recordRun`'s promise resolves quickly -- as the test this replaces
 * did -- passes even if the session or watchdog `recordRun` is supposed to
 * clean up is never actually closed. Only a real, separate process, with
 * nothing else of its own to keep it alive, can prove that.
 *
 * Imports the built package rather than the TypeScript source both other
 * test files in this package import directly, because this runs as its own
 * OS process rather than inside Vitest's own module graph, which is what
 * resolves a workspace package straight to source with no build step. `pnpm
 * test` always runs after `pnpm build` in this repo's own gate, so the dist
 * this reads is never stale by the time this check does.
 *
 * argv: [inspectUrl, cwd]
 */
import { adapter } from '../../dist/index.js';
import { resolveConfig } from '@covsel/core';

const [, , inspectUrl, cwd] = process.argv;

const config = resolveConfig({
  granularity: 'file',
  harness: {
    run: '--only {id}',
    server: { inspectUrl, observes: ['**'] },
    boundary: {},
  },
});

/** `post(path, body)`, exactly as `boundary-server.test.ts`'s own `POST_HELPER`
 * miniHarness scripts use it. */
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
    // Reports "begin" and then exits 0 without ever reporting "end" -- the
    // exact B4 scenario: a harness that (incorrectly) thinks it is done,
    // leaving the window open for `recordRun` itself to close.
    `${POST_HELPER}post('/begin',{id:'a'});`,
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

// Deliberately no `process.exit()` here. If `recordRun` left a coverage
// session, a watchdog timer, or the boundary HTTP server itself still
// referenced by anything, one of those keeps this process's event loop
// alive and it never exits on its own -- which is exactly the hang this
// check exists to catch.
