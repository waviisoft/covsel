/**
 * Test-only orchestration standing in for what a real project's CI does: start
 * the application server, with its inspector open, before covsel ever tries to
 * record it, and keep it running for the whole recording.
 *
 * This adapter never starts or stops the server itself -- see `index.ts`'s
 * doc comment -- so the conformance suite has to, exactly as it would in a
 * real pipeline. `createRecorder` is the one hook the suite calls with the
 * project's own `cwd` already resolved and before any test is recorded, which
 * makes it the equivalent of a CI step's "start the server, wait for it, then
 * run covsel" -- so that is where this wraps in.
 *
 * Each call picks a fresh pair of ports so `createProject`'s per-check temp
 * directories, which is one call to this per check, never collide. The
 * previous instance is killed before the next one starts rather than left to
 * exit with the whole test process -- checks run in the hundreds across both
 * registrations, and that many inspector sockets left open at once is exactly
 * the kind of resource exhaustion that turns a later, unrelated check's
 * connection attempt into a hang instead of a failure.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type { Adapter, RecorderInit, Recorder } from '@covsel/core';

import { APP_URL_ENV, HTTP_PORT_ENV } from './fixture-app.js';

let nextPort = 46000;
let current: ChildProcess | undefined;

/** Kill whatever fixture server is running. Safe to call when none is. */
export function stopFixtureServer(): void {
  current?.kill();
  current = undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True once a GET to `url` answers at all, checked from a one-off Node process. */
function isUp(url: string): boolean {
  const script = `fetch(${JSON.stringify(url)}).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`;
  return spawnSync(process.execPath, ['-e', script]).status === 0;
}

function waitUntilUp(url: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isUp(url)) return;
    sleepSync(25);
  }
  throw new Error(`the fixture server never answered ${url} within ${timeoutMs}ms`);
}

function startServer(cwd: string, httpPort: number, inspectPort: number): void {
  stopFixtureServer();
  current = spawn(
    process.execPath,
    [`--inspect=127.0.0.1:${inspectPort}`, 'server/serve.mjs'],
    { cwd, env: { ...process.env, [HTTP_PORT_ENV]: String(httpPort) }, stdio: 'ignore' },
  );
  waitUntilUp(`http://127.0.0.1:${httpPort}/health`, 10_000);
}

/**
 * Wrap an adapter so every recorder it builds is preceded by a fresh instance
 * of the fixture's application server, pointed at that recorder's own project
 * and inspector port. Only for the conformance suite's own use.
 */
export function withFixtureServer(adapter: Adapter): Adapter {
  return {
    ...adapter,
    createRecorder(init: RecorderInit): Recorder {
      const httpPort = nextPort++;
      const inspectPort = nextPort++;
      startServer(init.cwd, httpPort, inspectPort);
      // The recorder spawns the harness inheriting this process's environment,
      // so this is how it learns where the fixture server it just started is
      // listening -- checks run one at a time, so a later call overwriting this
      // before an earlier recording reads it cannot happen.
      process.env[APP_URL_ENV] = `http://127.0.0.1:${httpPort}`;
      const harnessRaw = init.config.harness;
      const harness =
        typeof harnessRaw === 'object' && harnessRaw !== null ? harnessRaw : {};
      const serverRaw = (harness as { server?: unknown }).server;
      const server = typeof serverRaw === 'object' && serverRaw !== null ? serverRaw : {};
      const config = {
        ...init.config,
        harness: {
          ...harness,
          server: { ...server, inspectUrl: `http://127.0.0.1:${inspectPort}` },
        },
      };
      return adapter.createRecorder({ ...init, config });
    },
  };
}
