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
 * Each call lets the OS assign both ports (bind `0`, then read back the
 * actual port from the listening socket's own `address()`) rather than
 * picking a fixed pair itself -- a hard-coded, incrementing range can land
 * inside the kernel's ephemeral port range and collide with a port some
 * other process on the same machine picked for an unrelated, short-lived
 * connection, which is indistinguishable from the fixture server itself
 * failing to start. The previous instance is killed before the next one
 * starts rather than left to exit with the whole test process -- checks run
 * in the hundreds across both registrations, and that many inspector sockets
 * left open at once is exactly the kind of resource exhaustion that turns a
 * later, unrelated check's connection attempt into a hang instead of a
 * failure.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type { Adapter, RecorderInit, Recorder } from '@covsel/core';

import { APP_URL_ENV, HTTP_PORT_ENV } from './fixture-app.js';

let current: ChildProcess | undefined;

/**
 * Bind an OS-assigned loopback port, read it back, and release it -- exactly
 * long enough to learn a port nothing else is using yet. `createRecorder` (see
 * below) is synchronous, per the `Adapter` interface, so this reserves the
 * port the same way `isUp` below checks the server: a one-off child process,
 * waited on with `spawnSync`, that does the actual (necessarily asynchronous)
 * `net.Server#listen` and prints back what the OS gave it. There is an
 * unavoidable gap between this and the fixture server actually binding the
 * port, the same gap `boundary-server.ts` itself accepts by using
 * `listen(0, ...)` directly; unlike that server, this helper has to hand the
 * port to a process it spawns separately afterwards, so it cannot hold the
 * socket open across that spawn.
 */
function reserveLoopbackPort(): number {
  const script =
    "const net=require('node:net');" +
    'const s=net.createServer();' +
    "s.listen(0,'127.0.0.1',()=>{" +
    'process.stdout.write(String(s.address().port));' +
    's.close(()=>process.exit(0));' +
    '});';
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  if (res.error) throw res.error;
  const port = Number(res.stdout.trim());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not reserve a loopback port: ${res.stdout}${res.stderr}`);
  }
  return port;
}

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
      const httpPort = reserveLoopbackPort();
      // Reserved and released one at a time (see `reserveLoopbackPort`'s own
      // doc comment), so in the rare case the OS hands back the same port
      // twice in a row, ask again rather than starting the server on one
      // port for both roles.
      let inspectPort = reserveLoopbackPort();
      while (inspectPort === httpPort) inspectPort = reserveLoopbackPort();
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
