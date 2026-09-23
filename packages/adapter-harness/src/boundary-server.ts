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

import type { HarnessConfig } from './config.js';
import { BOUNDARY_ENV, isBeginMessage, isEndMessage } from './protocol.js';

export interface BoundaryRecorderInit {
  /** Base command, e.g. `['python3', 'harness/run.py', '--format', 'json']`. */
  command: string[];
  cwd: string;
  config: MapperConfig & Pick<CovselConfig, 'granularity'>;
  harness: HarnessConfig;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
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
    req.on('error', reject);
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

  return {
    observes: server.observes,
    async recordRun(): Promise<RecordedUnit[]> {
      if (bin === undefined) throw new Error('empty command');

      const units: RecordedUnit[] = [];
      const protocolErrors: string[] = [];
      let open: { id: string; session: RemoteCoverageSession } | undefined;

      const httpServer = createServer((req, res) => {
        handleRequest(req, res).catch(() => {
          if (!res.headersSent) respond(res, 400, { error: 'malformed request' });
        });
      });

      async function closeOpenWindow(): Promise<{
        scripts: Awaited<ReturnType<RemoteCoverageSession['take']>>;
      }> {
        const current = open;
        if (current === undefined) throw new Error('no open window');
        open = undefined;
        try {
          return { scripts: await current.session.take() };
        } finally {
          await current.session.close();
        }
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
        open = { id: body.id, session };
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
        const { scripts } = await closeOpenWindow();
        // A failed test's coverage cannot be trusted -- it may have stopped
        // before running the part of itself its coverage is really about. It is
        // dropped here rather than recorded as covering nothing, so it falls
        // into the same "the run never mentioned it" reconciliation that
        // already refuses the whole recording for a test nobody reported.
        if (body.outcome !== 'failed') {
          const files = await mapper.toFiles({ scripts });
          const blocks = wantBlocks ? await mapper.toBlocks({ scripts }) : [];
          units.push({ test: { file: body.id }, files, blocks });
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

      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address();
      if (address === null || typeof address === 'string') {
        throw new Error('covsel could not open the boundary server');
      }
      const boundaryUrl = `http://127.0.0.1:${address.port}`;

      try {
        const { status, signal, stdout, stderr } = await runHarness(bin, rest, {
          cwd: init.cwd,
          env: { ...process.env, [BOUNDARY_ENV]: boundaryUrl },
        });
        if (open !== undefined) {
          protocolErrors.push(
            `the harness exited while ${open.id} was still open, so its ` +
              'coverage window never closed and cannot be trusted.',
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
        httpServer.close();
      }

      if (protocolErrors.length > 0) {
        throw new Error(
          'the boundary protocol was violated, so this recording cannot be ' +
            `trusted:\n${protocolErrors.join('\n')}`,
        );
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
): Promise<HarnessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c));
    child.stderr.on('data', (c: Buffer) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
