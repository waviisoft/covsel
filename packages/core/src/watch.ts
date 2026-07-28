import { watch as fsWatch } from 'node:fs';
import { join, sep } from 'node:path';

import type { AffectedResult, SelectInit } from './commands.js';
import { selectAffected } from './commands.js';
import type { CovselConfig } from './config.js';
import { discoverTestFiles } from './discover.js';
import { filterUnignored } from './git.js';
import { toRepoRelative } from './paths.js';

/** How the watch loop learns that something on disk changed. */
export interface WatchSourceHandlers {
  /**
   * A path changed, repo-relative and forward-slashed. `undefined` when the
   * platform reported a change without naming the file — the loop must still
   * treat that as a change, since the alternative is not running.
   */
  change(path: string | undefined): void;
  /** The watcher itself broke and is no longer delivering events. */
  error(error: Error): void;
}

export interface WatchSource {
  close(): void;
}

export type WatchSourceFactory = (
  cwd: string,
  handlers: WatchSourceHandlers,
) => WatchSource;

/**
 * The default source: one recursive `node:fs` watcher over the repo. Node ≥ 22
 * supports recursive watching on every platform covsel targets, so this needs no
 * third-party watcher.
 */
export const createFsWatchSource: WatchSourceFactory = (cwd, handlers) => {
  const watcher = fsWatch(cwd, { recursive: true }, (_event, filename) => {
    handlers.change(
      filename === null ? undefined : String(filename).split(sep).join('/'),
    );
  });
  watcher.on('error', (e: unknown) => {
    handlers.error(e instanceof Error ? e : new Error(String(e)));
  });
  return { close: () => watcher.close() };
};

export type WatchEvent =
  /** The watcher is established and the loop is live. */
  | { kind: 'watching'; debounceMs: number }
  /** A debounced batch of changes is about to be turned into a selection. */
  | { kind: 'change'; paths: string[]; unnamed: boolean }
  /** What the batch selected. */
  | { kind: 'selected'; selection: AffectedResult }
  /** The runner finished with this exit code. */
  | { kind: 'ran'; code: number }
  /** A re-record after a green run finished. */
  | { kind: 'recorded'; ok: boolean; reason?: string }
  /** Something failed but the loop keeps watching. */
  | { kind: 'warning'; reason: string }
  /** The watcher itself died; the loop is stopping because it can no longer see changes. */
  | { kind: 'watcher-failed'; reason: string };

export interface WatchInit extends SelectInit {
  /**
   * Run one selection and resolve to the runner's exit code. Throwing is
   * survivable — the loop reports it and keeps watching.
   */
  run(selection: AffectedResult): number | Promise<number>;
  /**
   * Re-record the map after a run that exited 0. Omitted means the map is left
   * alone, which is the CLI default: re-recording costs a full suite run, and a
   * map that ages only ever over-selects.
   */
  record?: () => Promise<{ ok: boolean; reason?: string }>;
  /** Quiet period after the last change before running. Defaults to 200ms. */
  debounceMs?: number;
  /**
   * Longest a change may sit unrun while later changes keep resetting the quiet
   * period. Without a ceiling, anything writing faster than the debounce — a
   * `tsc --watch` next door — would hold the loop off indefinitely, which looks
   * exactly like a watcher that has stopped selecting. Defaults to five debounce
   * periods, and never less than a second.
   */
  maxWaitMs?: number;
  /** Run once before the first change arrives. Defaults to true. */
  initialRun?: boolean;
  onEvent?: (event: WatchEvent) => void;
  /** Stop the loop. */
  signal?: AbortSignal;
  /** Injection point for tests and embedders; defaults to a recursive fs watcher. */
  createSource?: WatchSourceFactory;
  /**
   * Selection function; defaults to `selectAffected`. The loop treats a throw
   * here as "impact unknown" and falls open to a full run, so an override never
   * gets to decide that nothing should run by failing.
   */
  select?: (init: SelectInit) => Promise<AffectedResult>;
}

const DEFAULT_DEBOUNCE_MS = 200;

/** A full-run result to fall back on when selection could not be computed. */
function fallOpen(cwd: string, config: CovselConfig, reason: string): AffectedResult {
  let tests: string[];
  try {
    tests = discoverTestFiles(cwd, config);
  } catch {
    // Even the test list is unknown: the runner still gets an unfiltered run.
    tests = [];
  }
  return { fullRun: true, reason, tests, selected: tests.map((file) => ({ file })) };
}

/**
 * True for the two kinds of path covsel writes to or reads through itself: git's
 * own directory, and the store the loop writes its map into. Filtering the store
 * is what keeps a re-record from waking the watcher that triggered it, and git
 * does not report its own internals as ignored, so neither can be left to the
 * ignore filter.
 *
 * Nothing else is dropped here. Build output is dropped by being gitignored,
 * which is the same test selection applies — so a path a diff would show, and a
 * selection would therefore act on, always reaches the loop.
 */
function isNoise(cwd: string, rel: string, storeDir: string): boolean {
  if (rel.split('/').includes('.git')) return true;
  // The configured dir is whatever the user wrote ('.covsel', './out/covsel',
  // an absolute path); resolve it the way the store does before comparing.
  const dir = toRepoRelative(cwd, join(cwd, storeDir));
  return dir !== undefined && (rel === dir || rel.startsWith(`${dir}/`));
}

/**
 * Watch the working tree and, on each debounced batch of changes, run the tests
 * those changes affect.
 *
 * The change events only decide *when* to select, never *what* to select: every
 * batch re-runs the full selection against the git diff, so a platform that
 * coalesces events, renames a directory, or reports a change without naming the
 * file still gets a complete answer. Selection that cannot be computed falls
 * open to a full run with a reason attached, a failing run leaves the loop
 * watching, and a watcher that dies stops the loop loudly rather than sitting
 * there looking healthy while nothing is selected.
 *
 * Resolves with an exit code once the signal aborts, or 1 if the watcher failed.
 */
export async function watchAffected(init: WatchInit): Promise<number> {
  const { cwd, config } = init;
  const debounceMs = init.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = init.maxWaitMs ?? Math.max(1000, debounceMs * 5);
  const select = init.select ?? selectAffected;
  // Reporting is the caller's code running inside the loop; if it throws, that
  // is the caller's bug and must not become a dead watcher.
  const emit = (event: WatchEvent): void => {
    try {
      init.onEvent?.(event);
    } catch {
      /* ignore */
    }
  };
  const since = init.since !== undefined ? { since: init.since } : {};

  let source: WatchSource | undefined;
  let pending = new Set<string>();
  let unnamed = false;
  /** When the oldest unrun change in the current batch arrived. */
  let batchStartedAt: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let code = 0;
  let settle: (() => void) | undefined;

  /** Resolve the caller once the loop is stopped and no run is in flight. */
  const finish = (): void => {
    if (settle !== undefined && stopped && !running) {
      const done = settle;
      settle = undefined;
      done();
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    source?.close();
    finish();
  };

  const schedule = (): void => {
    if (stopped || running) return;
    if (timer !== undefined) clearTimeout(timer);
    // Resetting the quiet period on every change is what collapses a burst into
    // one run, but it must not be able to postpone a run forever.
    const waited = batchStartedAt === undefined ? 0 : Date.now() - batchStartedAt;
    const delay = Math.max(0, Math.min(debounceMs, maxWaitMs - waited));
    timer = setTimeout(() => {
      timer = undefined;
      void cycle();
    }, delay);
  };

  /** One selection-and-run pass over everything that changed since the last one. */
  const cycle = async (initial = false): Promise<void> => {
    if (stopped || running) return;
    running = true;
    const paths = [...pending];
    const sawUnnamed = unnamed;
    pending = new Set();
    unnamed = false;
    batchStartedAt = undefined;
    try {
      // An unnamed change carries no path to judge, so it always runs. Named
      // paths that git ignores cannot appear in a diff, and dropping them is
      // what stops a runner's own output from re-triggering the loop; when git
      // cannot answer, every path comes back and the batch runs.
      const relevant = sawUnnamed ? paths : filterUnignored(cwd, paths);
      if (!initial) {
        if (!sawUnnamed && relevant.length === 0) return;
        emit({ kind: 'change', paths: relevant, unnamed: sawUnnamed });
      }
      await runOnce();
    } catch (e) {
      // Nothing a cycle does may escape it: the timer invokes this detached, so
      // an unhandled rejection here would take the host process down rather than
      // the loop. An embedder's onEvent throwing is the way in.
      emit({
        kind: 'warning',
        reason: `watch cycle failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      running = false;
      if (!stopped && (pending.size > 0 || unnamed)) schedule();
      finish();
    }
  };

  const runOnce = async (): Promise<void> => {
    let selection: AffectedResult;
    try {
      selection = await select({ cwd, config, ...since });
    } catch (e) {
      selection = fallOpen(
        cwd,
        config,
        `selection failed (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    emit({ kind: 'selected', selection });

    let exitCode: number;
    try {
      exitCode = await init.run(selection);
    } catch (e) {
      emit({
        kind: 'warning',
        reason: `run failed to start: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    emit({ kind: 'ran', code: exitCode });

    if (exitCode !== 0 || init.record === undefined) return;
    try {
      const recorded = await init.record();
      emit({
        kind: 'recorded',
        ok: recorded.ok,
        ...(recorded.reason !== undefined ? { reason: recorded.reason } : {}),
      });
    } catch (e) {
      emit({
        kind: 'recorded',
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handlers: WatchSourceHandlers = {
    change(path) {
      if (stopped) return;
      if (path === undefined) unnamed = true;
      else if (isNoise(cwd, path, config.store.dir)) return;
      else pending.add(path);
      batchStartedAt ??= Date.now();
      schedule();
    },
    error(error) {
      if (stopped) return;
      emit({ kind: 'watcher-failed', reason: error.message });
      code = 1;
      stop();
    },
  };

  try {
    source = (init.createSource ?? createFsWatchSource)(cwd, handlers);
  } catch (e) {
    emit({
      kind: 'watcher-failed',
      reason: `cannot watch ${cwd}: ${e instanceof Error ? e.message : String(e)}`,
    });
    return 1;
  }

  if (init.signal?.aborted === true) {
    stop();
    return code;
  }
  init.signal?.addEventListener('abort', stop, { once: true });

  emit({ kind: 'watching', debounceMs });

  const idle = new Promise<void>((resolve) => {
    settle = resolve;
  });
  if (init.initialRun !== false) await cycle(true);
  await idle;
  return code;
}
