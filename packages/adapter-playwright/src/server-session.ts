/**
 * The V8 profiler of the application server, over the wire.
 *
 * A UI test executes code in three places, and the second one covsel can reach
 * is the server the page talks to. Playwright starts it (`webServer`), so covsel
 * cannot spawn it under `NODE_V8_COVERAGE` directly — and even started that way,
 * something still has to trigger a dump at each test boundary and read the
 * directory back, since nothing of covsel runs inside the server to do it from in
 * there. Node's own inspector answers both: it speaks while the process is
 * alive, and it can evaluate the one line that triggers a dump.
 *
 * Two sessions live here, for the two ways a project can start its server.
 * `RemoteBootDeltaSession` is the one to prefer: the server started with
 * `NODE_V8_COVERAGE` has had V8 collecting block-level coverage since bootstrap,
 * so this reads a boot dump plus one delta per test straight off disk — real
 * block granularity for whatever the server loaded before its first test, not
 * just for what a test loads on demand. `RemoteCoverageSession` is the fallback
 * for a server that cannot be started that way: a session per test, started
 * inside it and stopped at the end, so what comes back is what that test made
 * the server do — but coverage was not running before the session started, so a
 * module loaded at boot keeps only file granularity.
 *
 * The project opts in by starting its server with `--inspect`. Nothing of covsel
 * runs inside it either way.
 */
import { BootDeltaCoverage, type ScriptCoverage } from '@covsel/core';

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

/**
 * A CDP request/response socket to one inspector target, and nothing about what
 * either session does with it — finding the target, opening the socket, and
 * matching a reply back to the call that made it, which both sessions need
 * identically.
 */
class InspectorLink {
  private readonly inspectUrl: string;
  private readonly timeoutMs: number;
  private socket: WebSocket | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(inspectUrl: string, timeoutMs: number) {
    this.inspectUrl = inspectUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  get connected(): boolean {
    return this.socket !== undefined;
  }

  async connect(): Promise<void> {
    if (this.socket !== undefined) return;
    this.socket = await this.open();
  }

  async post(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (socket === undefined) throw new Error('coverage session not started');
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

  close(): void {
    const socket = this.socket;
    if (socket === undefined) return;
    this.socket = undefined;
    this.settleAll(new Error('the inspector connection closed'));
    socket.close();
  }

  private settleAll(error: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(error);
    this.pending.clear();
  }

  /** Find the target Node publishes and open a socket to it. */
  private async open(): Promise<WebSocket> {
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
}

export class RemoteCoverageSession {
  private readonly link: InspectorLink;

  constructor(inspectUrl: string, init: RemoteCoverageSessionInit = {}) {
    this.link = new InspectorLink(inspectUrl, init.timeoutMs ?? TIMEOUT_MS);
  }

  async start(): Promise<void> {
    if (this.link.connected) return;
    await this.link.connect();
    await this.link.post('Profiler.enable');
    // The same options the in-process observer uses, because the same
    // snapshot-diff reads the result: call counts to tell "ran once" from "ran
    // again", and block detail so an unexecuted function is visible as a
    // zero-count range rather than merely absent.
    await this.link.post('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true,
    });
  }

  async take(): Promise<ScriptCoverage[]> {
    const { result } = (await this.link.post('Profiler.takePreciseCoverage')) as {
      result: ScriptCoverage[];
    };
    return result;
  }

  async close(): Promise<void> {
    if (!this.link.connected) return;
    try {
      // Best effort: the server may already be shutting down, and a recording
      // that has its coverage has nothing left to lose here.
      await this.link.post('Profiler.stopPreciseCoverage');
    } catch {
      /* the coverage is already collected */
    }
    this.link.close();
  }
}

/**
 * The server window for a target started with `NODE_V8_COVERAGE`: one boot dump
 * plus one delta per test, read from that directory over the inspector rather
 * than from a fresh per-test session.
 *
 * Opened once and kept for the life of the recording rather than per test —
 * boot has to be read before the first test, and every later window is a delta
 * off the one running collection, not a new one. `endTest` is what a fixture
 * calls after each test; there is no `startTest`, because coverage has already
 * been running since `start()` and there is nothing to baseline.
 */
export class RemoteBootDeltaSession {
  private readonly link: InspectorLink;
  private readonly coverageDir: string;
  private bootDelta: BootDeltaCoverage | undefined;

  constructor(
    inspectUrl: string,
    coverageDir: string,
    init: RemoteCoverageSessionInit = {},
  ) {
    this.link = new InspectorLink(inspectUrl, init.timeoutMs ?? TIMEOUT_MS);
    this.coverageDir = coverageDir;
  }

  async start(): Promise<void> {
    if (this.bootDelta) return;
    await this.link.connect();
    await this.link.post('Runtime.enable');
    const pid = await this.pid();
    const bootDelta = new BootDeltaCoverage({
      dir: this.coverageDir,
      pid,
      trigger: () => this.trigger(),
    });
    await bootDelta.start();
    this.bootDelta = bootDelta;
  }

  /** This test's delta, unioned with boot. */
  async endTest(): Promise<ScriptCoverage[]> {
    if (!this.bootDelta) throw new Error('coverage session not started');
    return this.bootDelta.endTest();
  }

  async close(): Promise<void> {
    this.bootDelta = undefined;
    this.link.close();
  }

  /** The target's own process id, read once, so a worker or child's dump in the same directory is told apart from it. */
  private async pid(): Promise<number> {
    const result = (await this.link.post('Runtime.evaluate', {
      expression: 'process.pid',
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = result.result?.value;
    if (typeof value !== 'number') {
      throw new Error(
        "covsel could not read the server's process id over the inspector " +
          '(`Runtime.evaluate` of `process.pid` returned something other than a ' +
          'number). The boot-delta server window needs it to tell the tracked ' +
          "process's own coverage dumps apart from a worker or child process " +
          'that inherited the same `NODE_V8_COVERAGE` directory.',
      );
    }
    return value;
  }

  /**
   * `process.getBuiltinModule` rather than `require`/`import`: the server may be
   * ESM or CJS, and this has to work in either without depending on what the
   * evaluated expression's scope happens to have in it. Requires the server on
   * Node >=22.3.
   */
  private async trigger(): Promise<void> {
    await this.link.post('Runtime.evaluate', {
      expression: "process.getBuiltinModule('node:v8').takeCoverage()",
      returnByValue: true,
    });
  }
}
