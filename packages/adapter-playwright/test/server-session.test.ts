import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { RemoteCoverageSession } from '../src/server-session.js';

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

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
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
