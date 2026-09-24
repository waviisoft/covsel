/**
 * Recording mode (b): one invocation, a cooperating harness.
 *
 * covsel starts a small HTTP server before spawning the harness and hands it
 * the server's URL as `COVSEL_BOUNDARY`. A cooperating harness posts `/begin`
 * and `/end` around each test and waits for the response before continuing —
 * see `protocol.ts` for the wire shape. This is what lets the full run CI
 * already does on the default branch also be the recording: nothing about the
 * harness invocation changes, and a harness that does not read the variable
 * simply runs as it always has.
 *
 * The application server, again, has to already be running with its inspector
 * open; this only ever connects to it.
 *
 * The server binds to loopback only, and the URL handed to the harness embeds
 * a random per-recording token as a URL path segment — `{COVSEL_BOUNDARY}` is
 * already `http://127.0.0.1:PORT/<token>`, so a cooperating harness's own
 * `{COVSEL_BOUNDARY}/begin` and `{COVSEL_BOUNDARY}/end` need no change to
 * carry it. Both endpoints also require `content-type: application/json`.
 * Neither is a defense against a hostile local user — loopback binding alone
 * would stop that — it is a defense against a stray or malicious `text/plain`
 * POST needing no CORS preflight from a page the harness itself may be
 * driving in a browser, which could otherwise corrupt a window's timing
 * without the harness's cooperation at all.
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  type CovselConfig,
  type MapperConfig,
  type Recorder,
  type RecordedUnit,
  RemoteCoverageSession,
  V8FileMapper,
} from '@covsel/core';

import { DEFAULT_TEST_TIMEOUT_MS, type HarnessConfig } from './config.js';
import { BOUNDARY_ENV, isBeginMessage, isEndMessage } from './protocol.js';

export interface BoundaryRecorderInit {
  /** Base command, e.g. `['python3', 'harness/run.py', '--format', 'json']`. */
  command: string[];
  cwd: string;
  config: MapperConfig & Pick<CovselConfig, 'granularity'>;
  harness: HarnessConfig;
}

/** Small, fixed, and unrelated to test duration -- this bounds only how long a
 * tiny JSON request body may take to arrive, not how long a test runs. */
const BODY_TIMEOUT_MS = 30_000;

/** How long a killed process group is given to exit on SIGTERM before the
 * escalation to SIGKILL -- long enough for ordinary cleanup, short enough
 * that a stuck harness's watchdog still resolves promptly. */
const KILL_GRACE_MS = 2_000;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`the request body did not finish within ${BODY_TIMEOUT_MS}ms`));
    }, BODY_TIMEOUT_MS);
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type'];
  return (
    typeof contentType === 'string' &&
    contentType.toLowerCase().split(';')[0]?.trim() === 'application/json'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One test's coverage window. `pending` is a synchronous reservation held
 * from the moment `/begin` is accepted until `session.start()` resolves, so a
 * second `/begin` arriving before that await settles sees the reservation and
 * is rejected exactly as it would be once the window is fully `open` --
 * without it, two concurrent `/begin` calls could both pass the "nothing is
 * open" check before either set anything, and both would be acknowledged.
 */
type Window =
  | { state: 'pending'; id: string }
  | {
      state: 'open';
      id: string;
      session: RemoteCoverageSession;
      watchdog: NodeJS.Timeout;
    };

export function createBoundaryRecorder(init: BoundaryRecorderInit): Recorder {
  const [bin, ...rest] = init.command;
  const { server, boundary } = init.harness;
  const wantBlocks = init.config.granularity !== 'file';
  const mapper = new V8FileMapper({ cwd: init.cwd, config: init.config });
  const sessionInit =
    boundary?.timeoutMs !== undefined ? { timeoutMs: boundary.timeoutMs } : {};
  const testTimeoutMs = boundary?.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const settleMs = server.settleMs;

  return {
    observes: server.observes,
    // Every id is whatever the harness posted to `/begin`/`/end`, never a path
    // this process reads -- exactly what lets covsel record a scenario that is
    // not a file in this repository at all, when one is named only by a
    // configured `inventory`.
    recordsInventoryIds: true,
    async recordRun(): Promise<RecordedUnit[]> {
      if (bin === undefined) throw new Error('empty command');

      // A fresh, unguessable path segment per recording -- see this module's
      // own doc comment for why. Embedded in the base URL the harness gets,
      // never in a header it would have to be taught to send, so a harness
      // that already appends `/begin`/`/end` to `COVSEL_BOUNDARY` carries it
      // automatically.
      const token = randomBytes(16).toString('hex');
      const beginPath = `/${token}/begin`;
      const endPath = `/${token}/end`;

      const units: RecordedUnit[] = [];
      const protocolErrors: string[] = [];
      let slot: Window | undefined;
      let harness: ReturnType<typeof runHarness> | undefined;

      const httpServer = createServer((req, res) => {
        handleRequest(req, res).catch((err: unknown) => {
          if (!res.headersSent) {
            respond(res, 400, {
              error: err instanceof Error ? err.message : 'malformed request',
            });
          }
        });
      });

      async function handleBegin(res: ServerResponse, body: unknown): Promise<void> {
        if (!isBeginMessage(body)) {
          respond(res, 400, { error: 'malformed /begin body, expected {"id": string}' });
          return;
        }
        if (slot !== undefined) {
          protocolErrors.push(
            `covsel received "begin" for ${body.id} while ${slot.id} was still ` +
              'open -- the boundary protocol runs one test at a time, and the ' +
              'coverage window that was just interrupted cannot be trusted for ' +
              'either test.',
          );
          respond(res, 409, { error: `${slot.id} is still open` });
          return;
        }
        // Reserved synchronously, before the `await` below, so a second
        // `/begin` racing this one sees `slot !== undefined` immediately.
        slot = { state: 'pending', id: body.id };
        const session = new RemoteCoverageSession(server.inspectUrl, sessionInit);
        try {
          await session.start();
        } catch (err) {
          slot = undefined;
          protocolErrors.push(
            `covsel could not open a coverage window for ${body.id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          respond(res, 502, { error: 'could not open a coverage window' });
          return;
        }
        const id = body.id;
        // A safety net against a genuinely stuck harness or application, not a
        // budget for a slow test -- see `testTimeoutMs`'s own doc comment. Firing
        // it kills the harness so the recording can fail cleanly instead of
        // hanging `covsel record` with nothing to explain why.
        const watchdog = setTimeout(() => {
          protocolErrors.push(
            `${id} did not report "end" within ${testTimeoutMs}ms of "begin" -- ` +
              'treating the harness as stuck rather than waiting on it forever.',
          );
          slot = undefined;
          void session.close().catch(() => undefined);
          harness?.kill();
        }, testTimeoutMs);
        slot = { state: 'open', id, session, watchdog };
        respond(res, 200, {});
      }

      async function handleEnd(res: ServerResponse, body: unknown): Promise<void> {
        if (!isEndMessage(body)) {
          respond(res, 400, {
            error: 'malformed /end body, expected {"id": string, "outcome": string}',
          });
          return;
        }
        if (slot === undefined || slot.state !== 'open' || slot.id !== body.id) {
          protocolErrors.push(
            `covsel received "end" for ${body.id} with no matching open test ` +
              `(${slot === undefined ? 'none was open' : `${slot.id} was`}).`,
          );
          respond(res, 409, { error: 'no matching open test' });
          return;
        }
        const { session, watchdog } = slot;
        clearTimeout(watchdog);
        slot = undefined;

        // A skipped test covers nothing, by definition -- it never ran, so
        // whatever happened on the server during its window belongs to no
        // test at all and is not meaningfully its coverage. Recorded as
        // `{files: [], blocks: []}` rather than run through the mapper, which
        // is the honest reading and, on its own, always re-selects it rather
        // than risking under-selection from coverage that was really someone
        // else's.
        if (body.outcome === 'skipped') {
          await session.close().catch(() => undefined);
          units.push({ test: { file: body.id }, files: [], blocks: [] });
          respond(res, 200, {});
          return;
        }

        // An explicit, opt-in mitigation for work the server keeps doing after
        // it has already responded to the client -- see `settleMs`'s own doc
        // comment for what this does and does not guarantee.
        if (settleMs !== undefined && settleMs > 0) {
          await sleep(settleMs);
        }

        let scripts: Awaited<ReturnType<RemoteCoverageSession['take']>>;
        try {
          scripts = await session.take();
        } catch (err) {
          protocolErrors.push(
            `covsel could not read ${body.id}'s coverage: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          respond(res, 502, { error: 'could not read coverage' });
          return;
        } finally {
          await session.close().catch(() => undefined);
        }
        // A failed test's coverage cannot be trusted -- it may have stopped
        // before running the part of itself its coverage is really about. It is
        // dropped here rather than recorded as covering nothing, so it falls
        // into the same "the run never mentioned it" reconciliation that
        // already refuses the whole recording for a test nobody reported.
        if (body.outcome !== 'failed') {
          try {
            const files = await mapper.toFiles({ scripts });
            const blocks = wantBlocks ? await mapper.toBlocks({ scripts }) : [];
            units.push({ test: { file: body.id }, files, blocks });
          } catch (err) {
            // Named here rather than left to the generic reconciliation: the run
            // did mention this test, so "the run never reported it" would be the
            // wrong reason, and the real one -- an unmappable script -- is
            // exactly what a project needs to see to fix it.
            protocolErrors.push(
              `covsel could not map ${body.id}'s coverage to a source: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            respond(res, 500, { error: 'could not map coverage' });
            return;
          }
        }
        respond(res, 200, {});
      }

      async function handleRequest(
        req: IncomingMessage,
        res: ServerResponse,
      ): Promise<void> {
        if (req.method !== 'POST') {
          respond(res, 404, { error: 'not found' });
          return;
        }
        if (!hasJsonContentType(req)) {
          respond(res, 400, { error: 'expected content-type: application/json' });
          return;
        }
        const body = await readJsonBody(req);
        if (req.url === beginPath) {
          await handleBegin(res, body);
        } else if (req.url === endPath) {
          await handleEnd(res, body);
        } else {
          respond(res, 404, { error: 'not found' });
        }
      }

      const boundaryUrl = await new Promise<string>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => {
          const address = httpServer.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('covsel could not open the boundary server'));
            return;
          }
          // Read back from the socket itself, not assumed from the host just
          // requested of `listen` -- what a test asserting this really is
          // loopback has to check.
          resolve(`http://${address.address}:${address.port}/${token}`);
        });
      });

      try {
        harness = runHarness(bin, rest, {
          cwd: init.cwd,
          env: { ...process.env, [BOUNDARY_ENV]: boundaryUrl },
        });
        const { status, signal, stdout, stderr } = await harness.result;
        if (slot !== undefined) {
          protocolErrors.push(
            `the harness exited while ${slot.id} was still open, so its ` +
              'coverage window never closed and cannot be trusted.',
          );
        }
        // Checked before the exit code: a watchdog killing a stuck harness, or
        // any other protocol violation, makes a non-zero/signalled exit the
        // *consequence* of the real reason rather than a second, competing one
        // -- and the specific reason is the one worth a project's attention.
        if (protocolErrors.length > 0) {
          throw new Error(
            'the boundary protocol was violated, so this recording cannot be ' +
              `trusted:\n${protocolErrors.join('\n')}`,
          );
        }
        if (status !== 0) {
          throw new Error(
            `the harness exited with ${status ?? `signal ${String(signal)}`} while ` +
              'recording the run. A suite that did not pass cannot be recorded: ' +
              `a test that failed partway executed part of what it covers.\n${stdout}${stderr}`,
          );
        }
      } finally {
        // A harness that exits (or is killed) while a window is still open
        // leaves that window's inspector session referenced by nothing else.
        // Closed here, after the error above is already constructed, so a
        // failure to close it cannot mask the real reason the recording
        // failed -- but never left dangling, since an open session can be
        // exactly what keeps `covsel record`'s process from exiting.
        if (slot !== undefined) {
          if (slot.state === 'open') {
            clearTimeout(slot.watchdog);
            await slot.session.close().catch(() => undefined);
          }
          slot = undefined;
        }
        httpServer.close();
      }

      return units;
    },
    unmappableAllowed(): string[] {
      return mapper.takeAllowedUnmappable();
    },
  };
}

interface HarnessRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface HarnessRun {
  result: Promise<HarnessRunResult>;
  /** Kill the harness -- used by a window's watchdog to fail a stuck recording
   * cleanly instead of waiting on it forever. */
  kill(): void;
}

/**
 * Send a signal to a process group, treating "it is already gone" as success
 * rather than an error -- the group can legitimately have exited between the
 * watchdog firing and this call, and that is not a failure to report.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/**
 * Spawned asynchronously rather than with `spawnSync`, because the boundary
 * server has to keep answering `/begin` and `/end` on this same event loop
 * while the harness runs -- a synchronous spawn would block it for the
 * duration of the whole suite, and every request the harness sent would queue
 * behind a process that is waiting for one of them to be answered.
 *
 * Spawned detached, in its own process group, so `kill()` can signal the
 * whole tree rather than only the direct child: a harness that is itself a
 * shell wrapper, a task runner, or anything else that forks its own children
 * would otherwise leave them running after `child.kill()`, and the watchdog
 * that is supposed to stop a stuck harness would not actually stop it.
 */
function runHarness(
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): HarnessRun {
  const child: ChildProcess = spawn(bin, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c));
  child.stderr?.on('data', (c: Buffer) => (stderr += c));
  let escalate: NodeJS.Timeout | undefined;
  const result = new Promise<HarnessRunResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => {
      if (escalate !== undefined) clearTimeout(escalate);
      resolve({ status, signal, stdout, stderr });
    });
  });
  return {
    result,
    kill: () => {
      const pid = child.pid;
      // `spawn` itself failed to produce a process at all -- nothing to kill,
      // and `child.on('error', ...)` above already reports that failure.
      if (pid === undefined) return;
      killProcessGroup(pid, 'SIGTERM');
      escalate = setTimeout(() => killProcessGroup(pid, 'SIGKILL'), KILL_GRACE_MS);
    },
  };
}
