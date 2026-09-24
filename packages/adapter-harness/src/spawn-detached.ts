/**
 * Spawn a harness process asynchronously, detached into its own process
 * group, with a kill path that reaches that whole group rather than only the
 * direct child -- and, for as long as the run is in flight, forward the
 * signals that would ordinarily terminate covsel itself to that same group.
 *
 * Both recording modes need exactly this shape. A synchronous spawn would
 * block whichever event loop has to keep doing something else while the
 * harness runs -- the boundary server has to keep answering `/begin` and
 * `/end` on it, and per-test mode's own timeout (below, its caller's
 * responsibility) has to run on the same clock as the process it bounds
 * rather than depend on a spawn call's own, child-only `timeout` option.
 * Detached, in its own process group, so `kill()` can signal the whole tree:
 * a harness that is itself a shell wrapper, a task runner, or anything else
 * that forks its own children would otherwise leave them running after
 * `child.kill()`.
 *
 * That same detachment is what takes the harness out of covsel's own
 * foreground process group, though -- a Ctrl-C, a closed terminal (SIGHUP),
 * or CI cancelling the covsel process (SIGTERM) would otherwise never reach
 * it at all, leaving it running with no covsel process left to ever kill it.
 * Forwarding those three signals here, for exactly as long as this run is in
 * flight, is what keeps interrupting covsel equivalent to interrupting the
 * harness too.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface SpawnDetachedResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface SpawnDetachedRun {
  result: Promise<SpawnDetachedResult>;
  /** Kill the whole process group -- SIGTERM first, escalating to SIGKILL
   * after `KILL_GRACE_MS` if it has not exited by then. */
  kill(): void;
}

/** How long a killed process group is given to exit on SIGTERM before the
 * escalation to SIGKILL -- long enough for ordinary cleanup, short enough
 * that a stuck harness's watchdog still resolves promptly. */
export const KILL_GRACE_MS = 2_000;

/** Signals that would ordinarily terminate covsel itself, and so have to
 * reach a running harness too: an interactive Ctrl-C, a closed terminal, and
 * CI cancelling the job. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Send a signal to a process group, treating "it is already gone" as success
 * rather than an error -- the group can legitimately have exited between a
 * watchdog firing and this call, and that is not a failure to report.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/**
 * Register SIGINT/SIGTERM/SIGHUP handlers that kill `pid`'s process group
 * before letting that signal's default handling continue on covsel's own
 * process. Returns a function that removes them again -- called once the run
 * they belong to has settled, so nothing here outlives one harness run or
 * touches a covsel process that is not currently waiting on one.
 */
function forwardSignalsTo(pid: number): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const remove = (): void => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  for (const signal of FORWARDED_SIGNALS) {
    const handler = (): void => {
      killProcessGroup(pid, 'SIGTERM');
      // Removed before re-sending, so the re-sent signal cannot loop back
      // into this same handler.
      remove();
      // Let the default OS/Node behaviour for this signal -- normally,
      // terminate -- still happen to covsel itself. This is not an attempt
      // to swallow the signal, only to make sure the harness's process group
      // dies first.
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return remove;
}

export function spawnDetached(
  bin: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): SpawnDetachedRun {
  const child: ChildProcess = spawn(bin, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c));
  child.stderr?.on('data', (c: Buffer) => (stderr += c));

  const pid = child.pid;
  const removeSignalForwarding = pid !== undefined ? forwardSignalsTo(pid) : undefined;

  let escalate: NodeJS.Timeout | undefined;
  const result = new Promise<SpawnDetachedResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => {
      if (escalate !== undefined) clearTimeout(escalate);
      resolve({ status, signal, stdout, stderr });
    });
  }).finally(() => {
    removeSignalForwarding?.();
  });

  return {
    result,
    kill: () => {
      // `spawn` itself failed to produce a process at all -- nothing to
      // kill, and `child.on('error', ...)` above already reports that
      // failure.
      if (pid === undefined) return;
      killProcessGroup(pid, 'SIGTERM');
      escalate = setTimeout(() => killProcessGroup(pid, 'SIGKILL'), KILL_GRACE_MS);
    },
  };
}
