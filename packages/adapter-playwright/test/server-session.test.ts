import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AmbiguousCoverageError } from '@covsel/core';

import { RemoteBootDeltaSession, RemoteCoverageSession } from '../src/server-session.js';

/**
 * The application server's profiler, over the wire.
 *
 * Every failure here has to end as a *failed* window rather than an empty one:
 * an empty window is a measurement saying the test ran no server code, which
 * selection reads as "covers nothing" and skips on every later server change. So
 * what is checked is that each way of going wrong throws, and throws promptly —
 * a call that waits out its timeout on a socket that is already gone turns a
 * recording into something nobody waits for.
 */

const servers: Server[] = [];
const children: ReturnType<typeof spawn>[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for Node's inspector HTTP endpoint, answering `/json/list`. */
async function inspectorStub(targets: unknown): Promise<string> {
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/json/list')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404).end('');
  });
  return listen(server);
}

/** A server that accepts the request and then never answers it. */
async function stallingServer(): Promise<string> {
  const server = createServer(() => {
    /* deliberately no response */
  });
  return listen(server);
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('reaching the server’s profiler', () => {
  it('throws when nothing is listening, naming the flag that fixes it', async () => {
    const session = new RemoteCoverageSession('http://127.0.0.1:1');
    await expect(session.start()).rejects.toThrow(/--inspect/);
    await session.close();
  });

  it('throws when the inspector publishes no debugger target', async () => {
    const session = new RemoteCoverageSession(await inspectorStub([{}]));
    await expect(session.start()).rejects.toThrow(/no debugger target/);
    await session.close();
  });

  it('will not follow a debugger target on another host', async () => {
    // `/json/list` is content covsel did not write. Opening a socket wherever it
    // points would turn recording into a connection generator aimed by whatever
    // answered — the same reason the source-map resolver will not follow a
    // `sourceMappingURL` to another origin.
    const url = await inspectorStub([
      { webSocketDebuggerUrl: 'ws://evil.example.com:9229/abc' },
    ]);
    const session = new RemoteCoverageSession(url);

    await expect(session.start()).rejects.toThrow(/another host/);
    await session.close();
  });

  it('gives up on a server that accepts and never answers', async () => {
    // A server too busy to answer, or wedged mid-shutdown. Without a deadline the
    // recording waits for it once per test, for as many tests as remain, and a
    // recording that looks hung is one nobody runs again.
    const session = new RemoteCoverageSession(await stallingServer(), {
      timeoutMs: 200,
    });

    const started = Date.now();
    await expect(session.start()).rejects.toThrow(/--inspect/);
    expect(Date.now() - started).toBeLessThan(5_000);
    await session.close();
  }, 20_000);
});

describe('taking what the server ran', () => {
  /**
   * A real Node process with its inspector open, which is what this drives.
   *
   * `--inspect=0` and the port read back from Node's own announcement, rather
   * than a port this picks: several of these run at once, and a guessed port
   * that another one already holds fails to bind and looks exactly like an
   * inspector that never came up.
   */
  async function inspectedProcess(): Promise<string> {
    const child = spawn(
      process.execPath,
      // Executing something on a timer, because precise coverage started fresh
      // reports only what ran after it started — an idle process reports nothing
      // and would make the assertions below pass on an empty list.
      ['--inspect=0', '-e', 'setInterval(() => JSON.parse(\'{"a":1}\'), 5);'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    children.push(child);
    const port = await new Promise<string>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(
        () => reject(new Error(`no inspector announced itself: ${seen}`)),
        20_000,
      );
      child.stderr?.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        const found = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(seen);
        if (found?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
    });
    return `http://127.0.0.1:${port}`;
  }

  it('returns V8 coverage for the process it was pointed at', async () => {
    // The whole point of the session, against a real inspector rather than a
    // stub: whatever comes back has to be the shape `V8FileMapper` reads, or the
    // window is empty and the test is recorded as covering no server code.
    const session = new RemoteCoverageSession(await inspectedProcess());
    await session.start();

    // Polled rather than taken once: precise coverage reports what ran *since*
    // it started, and the child's timer has not necessarily fired yet. Racing it
    // would assert on an empty list and call that a pass.
    let scripts = await session.take();
    for (let attempt = 0; attempt < 100 && scripts.length === 0; attempt++) {
      await new Promise((done) => setTimeout(done, 50));
      scripts = await session.take();
    }
    await session.close();

    expect(scripts.length).toBeGreaterThan(0);
    const [script] = scripts;
    expect(typeof script?.url).toBe('string');
    expect(Array.isArray(script?.functions)).toBe(true);
    // The shape `V8FileMapper` reads, which is the whole reason this exists.
    expect(Array.isArray(script?.functions[0]?.ranges)).toBe(true);
  }, 30_000);

  it('fails at once when the server dies mid-test, rather than waiting out the deadline', async () => {
    // The socket goes with the process, and `send` on a closed one is a no-op —
    // so without a close listener every call in flight, and every call after it,
    // waits out the full timeout. The window fails either way; this is the
    // difference between failing now and a recording that looks hung.
    const session = new RemoteCoverageSession(await inspectedProcess(), {
      timeoutMs: 30_000,
    });
    await session.start();

    for (const child of children.splice(0)) child.kill();
    const started = Date.now();
    await expect(session.take()).rejects.toThrow(/closed/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it('throws rather than returning nothing once the session is closed', async () => {
    // `take()` returning undefined would reach the mapper as `raw.scripts`
    // undefined and become an empty window — a measurement rather than a
    // failure.
    const session = new RemoteCoverageSession(await inspectedProcess());
    await session.start();
    await session.close();

    await expect(session.take()).rejects.toThrow(/not started/);
  }, 30_000);
});

describe('the boot-delta server window', () => {
  /**
   * A real Node process, started the way the boot-delta window needs: its
   * inspector open and `NODE_V8_COVERAGE` pointed at a directory this test can
   * read back. Ticks a timer so there is always something for a window after
   * the first to have picked up.
   */
  async function bootDeltaProcess(): Promise<{
    inspectUrl: string;
    coverageDir: string;
  }> {
    const coverageDir = mkdtempSync(join(tmpdir(), 'covsel-pw-ss-bootdelta-'));
    dirs.push(coverageDir);
    const child = spawn(
      process.execPath,
      ['--inspect=0', '-e', 'setInterval(() => JSON.parse(\'{"a":1}\'), 5);'],
      {
        env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    children.push(child);
    const port = await new Promise<string>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(
        () => reject(new Error(`no inspector announced itself: ${seen}`)),
        20_000,
      );
      child.stderr?.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        const found = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(seen);
        if (found?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
    });
    return { inspectUrl: `http://127.0.0.1:${port}`, coverageDir };
  }

  it('returns boot plus a delta for the process it was pointed at', async () => {
    const { inspectUrl, coverageDir } = await bootDeltaProcess();
    const session = new RemoteBootDeltaSession(inspectUrl, coverageDir);
    await session.start();

    // Polled rather than taken once: the delta is whatever ran since start(),
    // and the child's timer has not necessarily ticked yet.
    let scripts = await session.endTest();
    for (let attempt = 0; attempt < 100 && scripts.length === 0; attempt++) {
      await new Promise((done) => setTimeout(done, 50));
      scripts = await session.endTest();
    }
    await session.close();

    expect(scripts.length).toBeGreaterThan(0);
    const [script] = scripts;
    expect(typeof script?.url).toBe('string');
    expect(Array.isArray(script?.functions)).toBe(true);
  }, 30_000);

  it('throws rather than returning nothing once the session is closed', async () => {
    const { inspectUrl, coverageDir } = await bootDeltaProcess();
    const session = new RemoteBootDeltaSession(inspectUrl, coverageDir);
    await session.start();
    await session.close();

    await expect(session.endTest()).rejects.toThrow(/not started/);
  }, 30_000);

  it('throws when nothing is listening, naming the flag that fixes it', async () => {
    const session = new RemoteBootDeltaSession('http://127.0.0.1:1', '/tmp');
    await expect(session.start()).rejects.toThrow(/--inspect/);
    await session.close();
  });

  /**
   * A real Node process running an app whose entry point imports a module
   * with top-level-only code — nothing in it is ever called again after the
   * process starts, the way a server's own config or route registration
   * often is — so a window can tell whether it saw that code from boot or
   * lost it.
   */
  async function reusableServerProcess(): Promise<{
    inspectUrl: string;
    coverageDir: string;
  }> {
    const coverageDir = mkdtempSync(join(tmpdir(), 'covsel-pw-ss-reuse-cov-'));
    const appDir = mkdtempSync(join(tmpdir(), 'covsel-pw-ss-reuse-app-'));
    dirs.push(coverageDir, appDir);
    writeFileSync(join(appDir, 'config.mjs'), 'globalThis.__configLoaded = true;\n');
    writeFileSync(
      join(appDir, 'main.mjs'),
      "import './config.mjs';\nsetInterval(() => JSON.parse('{\"a\":1}'), 5);\n",
    );
    const child = spawn(process.execPath, ['--inspect=0', join(appDir, 'main.mjs')], {
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    const port = await new Promise<string>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(
        () => reject(new Error(`no inspector announced itself: ${seen}`)),
        20_000,
      );
      child.stderr?.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        const found = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(seen);
        if (found?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
    });
    return { inspectUrl: `http://127.0.0.1:${port}`, coverageDir };
  }

  it('credits a second session with code that only ran at the process’s real startup, when it attaches to an already-booted process', async () => {
    // reuseExistingServer, a retried worker, or one worker per project can
    // all attach a fresh session to a server an earlier recording already
    // took a boot dump from. Both sessions have to see config.mjs, which
    // only ever ran once, before either session existed.
    const { inspectUrl, coverageDir } = await reusableServerProcess();

    const session1 = new RemoteBootDeltaSession(inspectUrl, coverageDir);
    await session1.start();
    await session1.endTest();
    await session1.close();

    const session2 = new RemoteBootDeltaSession(inspectUrl, coverageDir);
    await session2.start();
    const scripts = await session2.endTest();

    expect(scripts.some((s) => s.url.includes('config.mjs'))).toBe(true);
  }, 30_000);

  it('shares boot across sessions even when the server’s own uptime() lies and real time passes between them', async () => {
    // The marker mechanism reads nothing from the clock, but this guards
    // against that regressing silently: a server whose own process.uptime()
    // is wrong (or simply asleep for a while, which has the same effect on
    // the elapsed-time math a clock-based check would have done) must not
    // affect whether a second session correctly reuses the first's boot.
    const coverageDir = mkdtempSync(join(tmpdir(), 'covsel-pw-ss-reuse-cov-'));
    const appDir = mkdtempSync(join(tmpdir(), 'covsel-pw-ss-reuse-app-'));
    dirs.push(coverageDir, appDir);
    writeFileSync(join(appDir, 'config.mjs'), 'globalThis.__configLoaded = true;\n');
    writeFileSync(
      join(appDir, 'main.mjs'),
      "import './config.mjs';\n" +
        'process.uptime = () => 0;\n' +
        'setInterval(() => JSON.parse(\'{"a":1}\'), 5);\n',
    );
    const child = spawn(process.execPath, ['--inspect=0', join(appDir, 'main.mjs')], {
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(child);
    const port = await new Promise<string>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(
        () => reject(new Error(`no inspector announced itself: ${seen}`)),
        20_000,
      );
      child.stderr?.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        const found = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(seen);
        if (found?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
    });
    const inspectUrl = `http://127.0.0.1:${port}`;

    const session1 = new RemoteBootDeltaSession(inspectUrl, coverageDir);
    await session1.start();
    await session1.endTest();
    await session1.close();

    await new Promise((resolve) => setTimeout(resolve, 2_600));

    const session2 = new RemoteBootDeltaSession(inspectUrl, coverageDir);
    await session2.start();
    const scripts = await session2.endTest();

    expect(scripts.some((s) => s.url.includes('config.mjs'))).toBe(true);
  }, 30_000);

  it('fails a second session, rather than silently re-booting, when the coverage directory is cleared while the server stays up', async () => {
    // The server's own marker still says it already booted; a directory a
    // project resets before every `covsel record` invocation must not be
    // read as "this process has never been observed", or the second
    // session's own first dump would be taken as boot -- a partial capture.
    const { inspectUrl, coverageDir } = await reusableServerProcess();

    const session1 = new RemoteBootDeltaSession(inspectUrl, coverageDir);
    await session1.start();
    await session1.close();

    rmSync(coverageDir, { recursive: true, force: true });
    mkdirSync(coverageDir, { recursive: true });

    const session2 = new RemoteBootDeltaSession(inspectUrl, coverageDir);
    await expect(session2.start()).rejects.toThrow(AmbiguousCoverageError);
  }, 30_000);

  /**
   * Sets the target's boot marker directly, over a throwaway CDP connection
   * of its own -- standing in for what a session's own `start()` leaves
   * behind when its boot trigger has already reset the target's counters but
   * then fails before it can record a real dump's filename: the marker is
   * claimed, but nothing in the directory matches it.
   */
  async function setBootMarkerDirectly(inspectUrl: string, value: string): Promise<void> {
    const res = await fetch(`${inspectUrl}/json/list`);
    const targets = (await res.json()) as { webSocketDebuggerUrl?: string }[];
    const wsUrl = targets.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
    if (wsUrl === undefined) throw new Error('no debugger target published');
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('could not connect')));
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', function handle(event: MessageEvent) {
        const message = JSON.parse(event.data as string) as {
          id?: number;
          error?: { message?: string };
        };
        if (message.id !== 1) return;
        socket.removeEventListener('message', handle);
        if (message.error) reject(new Error(message.error.message));
        else resolve();
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `globalThis[Symbol.for('covsel.bootDump')] = ${JSON.stringify(value)}`,
          },
        }),
      );
    });
    socket.close();
  }

  it('fails a session, rather than silently booting, when the target already claims a boot marker with no matching dump', async () => {
    // Exactly what start() itself leaves the target holding when an earlier
    // session's boot trigger reset the process's counters but then failed
    // before it could record a real dump's filename -- the marker is
    // claimed, and reading it back has to fail the same way a marker naming
    // a genuinely deleted dump does, not fall back to a fresh trigger that
    // would only be a delta off the counters that reset already reset.
    const { inspectUrl, coverageDir } = await reusableServerProcess();

    await setBootMarkerDirectly(inspectUrl, 'pending');

    const session = new RemoteBootDeltaSession(inspectUrl, coverageDir);
    await expect(session.start()).rejects.toThrow(AmbiguousCoverageError);
  }, 30_000);

  it('fails at once on a call made after the server already died, not only one in flight', async () => {
    // The close listener settling calls already in flight is only half the
    // guard: without also clearing the socket, a call made *after* the crash
    // -- this window's own trigger, not one racing the process's death --
    // still thinks it is connected and waits out the full timeout on a send
    // that is a silent no-op.
    const { inspectUrl, coverageDir } = await bootDeltaProcess();
    const session = new RemoteBootDeltaSession(inspectUrl, coverageDir, {
      timeoutMs: 3_000,
    });
    await session.start();

    for (const child of children.splice(0)) child.kill();
    await new Promise((done) => setTimeout(done, 200)); // let the close event land

    const started = Date.now();
    await expect(session.endTest()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 30_000);

  it('surfaces the evaluated exception, not a generic "no dump", when the trigger call itself throws', async () => {
    // `process.getBuiltinModule` is undefined before Node 22.3, so calling
    // `.takeCoverage()` on it throws inside the evaluated expression --
    // reported by CDP as `exceptionDetails` on an otherwise-successful reply,
    // not as a protocol error. Standing in for that unsupported version by
    // overriding the same builtin to throw, rather than pinning an old Node
    // binary in the test matrix.
    const coverageDir = mkdtempSync(join(tmpdir(), 'covsel-pw-ss-bootdelta-'));
    dirs.push(coverageDir);
    const child = spawn(
      process.execPath,
      [
        '--inspect=0',
        '-e',
        "process.getBuiltinModule = () => { throw new Error('simulated missing getBuiltinModule'); }; setInterval(() => {}, 1000);",
      ],
      {
        env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    children.push(child);
    const port = await new Promise<string>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(
        () => reject(new Error(`no inspector announced itself: ${seen}`)),
        20_000,
      );
      child.stderr?.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        const found = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(seen);
        if (found?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(found[1]);
        }
      });
    });

    const session = new RemoteBootDeltaSession(`http://127.0.0.1:${port}`, coverageDir);
    await expect(session.start()).rejects.toThrow(/simulated missing getBuiltinModule/);
    await session.close();
  }, 30_000);
});
