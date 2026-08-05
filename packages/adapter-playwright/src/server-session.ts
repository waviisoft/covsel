/**
 * The V8 profiler of the application server, over the wire.
 *
 * A UI test executes code in three places, and the second one covsel can reach
 * is the server the page talks to. Playwright starts it (`webServer`), so covsel
 * cannot spawn it under `NODE_V8_COVERAGE` — and that dump would only arrive at
 * exit, attributing a whole run's server execution to nothing in particular.
 * Node's own inspector answers both: it speaks while the process is alive, and it
 * speaks the protocol V8 coverage already comes in.
 *
 * A session per test, started inside it and stopped at the end, so what comes
 * back is what that test made the server do — no baseline to subtract, and
 * nothing of the previous test left in it. The cost is a connection per test; the
 * benefit is that no socket outlives the test that opened it, which in a
 * Playwright worker is the difference between a run that exits and one that
 * hangs.
 *
 * The project opts in by starting its server with `--inspect`. Nothing of covsel
 * runs inside it.
 */
import type { ScriptCoverage } from '@covsel/core';

/** What Node's inspector publishes about the target it will accept. */
interface InspectorTarget {
  webSocketDebuggerUrl?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Long enough for a loaded server, short enough not to hang a recording. */
const TIMEOUT_MS = 20_000;

/** What a caller may vary about how long this waits. */
export interface RemoteCoverageSessionInit {
  /**
   * How long any one call may take before the window is failed instead.
   *
   * A deadline rather than a preference: a server that accepts the connection
   * and then says nothing would otherwise be waited on once per test, and a
   * recording that looks hung is one nobody runs again.
   */
  timeoutMs?: number;
}

function advice(inspectUrl: string): string {
  return (
    `covsel could not reach an inspector at ${inspectUrl}. Recording the server ` +
    'window needs the application started with Node’s inspector open — ' +
    'put `--inspect` on the `webServer.command` in your Playwright config (for ' +
    'example `node --inspect=9229 server.js`) and point the fixture’s ' +
    '`server.inspectUrl` at it. Without it the server is unobserved, and a scope ' +
    'claiming otherwise would skip the tests a server change breaks.'
  );
}

/** True when a published debugger URL points at the host covsel was told about. */
function sameHost(wsUrl: string, inspectUrl: string): boolean {
  try {
    return new URL(wsUrl).host === new URL(inspectUrl).host;
  } catch {
    return false;
  }
}

export class RemoteCoverageSession {
  private readonly inspectUrl: string;
  private readonly timeoutMs: number;
  private socket: WebSocket | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(inspectUrl: string, init: RemoteCoverageSessionInit = {}) {
    this.inspectUrl = inspectUrl.replace(/\/+$/, '');
    this.timeoutMs = init.timeoutMs ?? TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.socket !== undefined) return;
    this.socket = await this.connect();
    await this.post('Profiler.enable');
    // The same options the in-process observer uses, because the same
    // snapshot-diff reads the result: call counts to tell "ran once" from "ran
    // again", and block detail so an unexecuted function is visible as a
    // zero-count range rather than merely absent.
    await this.post('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true,
    });
  }

  async take(): Promise<ScriptCoverage[]> {
    const { result } = (await this.post('Profiler.takePreciseCoverage')) as {
      result: ScriptCoverage[];
    };
    return result;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) return;
    this.socket = undefined;
    try {
      // Best effort: the server may already be shutting down, and a recording
      // that has its coverage has nothing left to lose here.
      await this.request(socket, 'Profiler.stopPreciseCoverage');
    } catch {
      /* the coverage is already collected */
    }
    this.settleAll(new Error('the inspector connection closed'));
    socket.close();
  }

  /** Fail every call still waiting, and forget them. */
  private settleAll(error: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(error);
    this.pending.clear();
  }

  /** Find the target Node publishes and open a socket to it. */
  private async connect(): Promise<WebSocket> {
    let targets: InspectorTarget[];
    try {
      const res = await fetch(`${this.inspectUrl}/json/list`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`the inspector answered ${res.status}`);
      targets = (await res.json()) as InspectorTarget[];
    } catch (err) {
      throw new Error(
        `${advice(this.inspectUrl)} (${err instanceof Error ? err.message : String(err)})`,
        { cause: err },
      );
    }
    const url = targets.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
    if (url === undefined) {
      throw new Error(`${advice(this.inspectUrl)} (it published no debugger target)`);
    }
    // The debugger URL is content covsel did not write, and opening a socket to
    // wherever it points would turn recording into a connection generator aimed
    // by whatever answered `/json/list` -- the same reason `SourceMapResolver`
    // will not follow a `sourceMappingURL` to another host.
    if (!sameHost(url, this.inspectUrl)) {
      throw new Error(
        `${advice(this.inspectUrl)} (it published a debugger target on another ` +
          `host, ${url}, which covsel will not connect to)`,
      );
    }

    const socket = new WebSocket(url);
    socket.addEventListener('message', (event: MessageEvent) => {
      this.deliver(event.data);
    });
    // A server that dies mid-test takes the socket with it, and `send` on a
    // closed one is a no-op -- so without this every call in flight, and every
    // call after it, waits out the full timeout. The window fails either way;
    // this is the difference between failing at once and a recording that looks
    // hung for as many timeouts as there are tests left.
    socket.addEventListener('close', () => {
      this.settleAll(new Error('the inspector connection closed'));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the inspector at ${url} did not accept a connection`)),
        this.timeoutMs,
      );
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(advice(this.inspectUrl)));
      });
    });
    return socket;
  }

  /** Match one protocol reply to the call waiting for it. */
  private deliver(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return;
    }
    // Events carry no id, and this speaks only in requests and replies.
    if (typeof message.id !== 'number') return;
    const waiter = this.pending.get(message.id);
    if (waiter === undefined) return;
    this.pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message ?? 'the inspector refused the call'));
    } else {
      waiter.resolve(message.result);
    }
  }

  private async post(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (socket === undefined) throw new Error('coverage session not started');
    return this.request(socket, method, params);
  }

  private async request(
    socket: WebSocket,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the inspector did not answer ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    });
  }
}
