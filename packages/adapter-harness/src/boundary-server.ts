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
 */
import { spawn } from 'node:child_process';
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

export function createBoundaryRecorder(init: BoundaryRecorderInit): Recorder {
  const [bin, ...rest] = init.command;
  const { server, boundary } = init.harness;
  const wantBlocks = init.config.granularity !== 'file';
  const mapper = new V8FileMapper({ cwd: init.cwd, config: init.config });
  const sessionInit =
    boundary?.timeoutMs !== undefined ? { timeoutMs: boundary.timeoutMs } : {};
  const testTimeoutMs = boundary?.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  return {
    observes: server.observes,
    async recordRun(): Promise<RecordedUnit[]> {
      if (bin === undefined) throw new Error('empty command');

      const units: RecordedUnit[] = [];
      const protocolErrors: string[] = [];
      let open:
        | { id: string; session: RemoteCoverageSession; watchdog: NodeJS.Timeout }
        | undefined;
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

      /** Stop the window's watchdog and give back its session, without closing it. */
      function takeOpenWindow(): { id: string; session: RemoteCoverageSession } {
        const current = open;
        if (current === undefined) throw new Error('no open window');
        clearTimeout(current.watchdog);
        open = undefined;
        return current;
      }

      async function handleBegin(res: ServerResponse, body: unknown): Promise<void> {
        if (!isBeginMessage(body)) {
          respond(res, 400, { error: 'malformed /begin body, expected {"id": string}' });
          return;
        }
        if (open !== undefined) {
          protocolErrors.push(
            `covsel received "begin" for ${body.id} while ${open.id} was still ` +
              'open -- the boundary protocol runs one test at a time, and the ' +
              'coverage window that was just interrupted cannot be trusted for ' +
              'either test.',
          );
          respond(res, 409, { error: `${open.id} is still open` });
          return;
        }
        const session = new RemoteCoverageSession(server.inspectUrl, sessionInit);
        try {
          await session.start();
        } catch (err) {
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
          open = undefined;
          void session.close().catch(() => undefined);
          harness?.kill();
        }, testTimeoutMs);
        open = { id, session, watchdog };
        respond(res, 200, {});
      }

      async function handleEnd(res: ServerResponse, body: unknown): Promise<void> {
        if (!isEndMessage(body)) {
          respond(res, 400, {
            error: 'malformed /end body, expected {"id": string, "outcome": string}',
          });
          return;
        }
        if (open === undefined || open.id !== body.id) {
          protocolErrors.push(
            `covsel received "end" for ${body.id} with no matching open test ` +
              `(${open === undefined ? 'none was open' : `${open.id} was`}).`,
          );
          respond(res, 409, { error: 'no matching open test' });
          return;
        }
        const { session } = takeOpenWindow();
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
          await session.close();
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
        const body = await readJsonBody(req);
        if (req.url === '/begin') {
          await handleBegin(res, body);
        } else if (req.url === '/end') {
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
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });

      try {
        harness = runHarness(bin, rest, {
          cwd: init.cwd,
          env: { ...process.env, [BOUNDARY_ENV]: boundaryUrl },
        });
        const { status, signal, stdout, stderr } = await harness.result;
        if (open !== undefined) {
          protocolErrors.push(
            `the harness exited while ${open.id} was still open, so its ` +
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
        if (open !== undefined) clearTimeout(open.watchdog);
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
 * Spawned asynchronously rather than with `spawnSync`, because the boundary
 * server has to keep answering `/begin` and `/end` on this same event loop
 * while the harness runs -- a synchronous spawn would block it for the
 * duration of the whole suite, and every request the harness sent would queue
 * behind a process that is waiting for one of them to be answered.
 */
function runHarness(
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): HarnessRun {
  const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c));
  child.stderr.on('data', (c: Buffer) => (stderr += c));
  const result = new Promise<HarnessRunResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return {
    result,
    kill: () => child.kill(),
  };
}
