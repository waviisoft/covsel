/**
 * Boot + per-window delta coverage, read from a `NODE_V8_COVERAGE` directory.
 *
 * A process started with `NODE_V8_COVERAGE=<dir>` (and, for a process covsel
 * cannot spawn itself, `--inspect`) has V8 collecting precise, block-level
 * coverage for every function from the moment it starts — including the ones
 * a module loaded at boot never runs. `start()` takes the very first dump:
 * that call sees everything compiled so far, with an un-run function reported
 * at count 0 rather than absent, which is the "boot" delta. Boot code runs
 * before every window and for every window, so it is unioned into each one's
 * result.
 *
 * Every window after that is exactly what changed since the previous dump —
 * Node resets the counters on each `takeCoverage()` call, so windows never
 * overlap. A dump this cannot attribute — none where one was expected, more
 * than one, or one from a pid it was not told to track (a worker or a child
 * process that inherited the same directory) — fails the window rather than
 * guessing which test it belongs to, the same standard the per-test inspector
 * session already holds itself to.
 *
 * Transport-agnostic on purpose: triggering the dump is the one thing that
 * differs between an in-process observer (a direct call) and a process covsel
 * only reaches over the inspector (a remote `Runtime.evaluate`), so it is the
 * one thing this takes as a callback. Everything else — reading the
 * directory, matching a dump to the tracked process, unioning boot in — is
 * the same read in both cases, and every caller needs the same fail-open
 * guarantee.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScriptCoverage } from './observer.js';

/**
 * Asks the target to write its next coverage dump and resolves once it has.
 *
 * Node can silently drop a dump requested with no yield at all after the
 * previous one — observed only back-to-back in the same synchronous
 * callstack, never once over the latency a real round trip already adds — so
 * an implementation that calls `takeCoverage()` in-process rather than over a
 * connection must still yield to a real timer afterward rather than return
 * immediately.
 */
export type CoverageDumpTrigger = () => Promise<void>;

export interface BootDeltaCoverageInit {
  /** Directory the target was started with `NODE_V8_COVERAGE` pointed at. */
  dir: string;
  /** The target's process id, so a dump from an untracked process or thread is caught. */
  pid: number;
  /** Triggers one `node:v8` `takeCoverage()` call in the target. */
  trigger: CoverageDumpTrigger;
}

/** A dump this could not attribute to the tracked process's main thread alone. */
export class AmbiguousCoverageError extends Error {}

const DUMP_NAME = /^coverage-(\d+)-\d+-(\d+)\.json$/;

/**
 * `tolerateMissing` is for the one read that happens before this session has
 * ever triggered a dump: Node creates the NODE_V8_COVERAGE directory lazily,
 * on its first write, not at bootstrap, so a target that has not taken its
 * first dump yet genuinely has no directory there. Once a trigger has run at
 * least once, the directory has to exist — an absent one from then on is not
 * "nothing written yet", it is a wrong path or a target that stopped writing
 * there, and either would silently read as this window covering nothing if
 * this treated it as empty instead of failing loudly.
 */
function dumpFiles(dir: string, tolerateMissing = false): Set<string> {
  try {
    return new Set(readdirSync(dir).filter((f) => DUMP_NAME.test(f)));
  } catch (err) {
    if (tolerateMissing && (err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return new Set();
    }
    throw new Error(
      `could not read the NODE_V8_COVERAGE directory ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

/** The tracked process's own main-thread dump, among files new since the last read. */
function ownDump(added: string[], pid: number): string {
  const mine: string[] = [];
  const foreign: string[] = [];
  for (const name of added) {
    const match = DUMP_NAME.exec(name);
    const filePid = match?.[1];
    const threadId = match?.[2];
    if (filePid === String(pid) && threadId === '0') mine.push(name);
    else foreign.push(name);
  }
  if (foreign.length > 0) {
    throw new AmbiguousCoverageError(
      `a coverage window saw ${foreign.length} dump(s) this session was not told to ` +
        `track (${foreign.join(', ')}), alongside the tracked process's own. A worker ` +
        'thread or a child process inherits `NODE_V8_COVERAGE` and writes into the same ' +
        'directory, and there is no reliable way to say which test its execution ' +
        'belongs to — recording it as this window’s would guess, and crediting it to ' +
        'none would silently under-report. Keep server-side work this session tracks off ' +
        'worker threads and child processes during a recording: delete ' +
        '`process.env.NODE_V8_COVERAGE` before spawning one (passing a narrower `env` to ' +
        '`spawn`/`execFileSync` is not enough — Node re-injects an active ' +
        '`NODE_V8_COVERAGE` into a child from the running process’s own environment ' +
        'regardless of what the call site passes), or point the child at a directory of ' +
        'its own.',
    );
  }
  if (mine.length > 1) {
    throw new AmbiguousCoverageError(
      `a coverage window saw ${mine.length} dumps from the tracked process ` +
        `(${mine.join(', ')}) instead of one. Two windows collapsed into one call, or a ` +
        'concurrent test triggered a second dump before this one’s was read — ' +
        'either way there is no telling the windows apart, so this fails rather than ' +
        'merging them into a guess.',
    );
  }
  return mine[0] ?? '';
}

function readScripts(path: string): ScriptCoverage[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { result?: ScriptCoverage[] };
  return parsed.result ?? [];
}

/**
 * Merge one script's boot shape with a window's own delta for it, by range
 * offset rather than function index — an index shifts the moment a function
 * first runs during the window, offsets do not.
 *
 * This is not a plain concatenation, and has to not be one: covsel's mapper
 * reads a *missing* range as "no data, assume it ran" (the safe reading for a
 * single, possibly-partial snapshot), but a post-reset delta omits an
 * untouched function on purpose, meaning it is known to have not run. Handed
 * to the mapper as two separate script entries, the delta entry alone would
 * read every function boot's entry already resolved as "missing" and count it
 * executed anyway, silently erasing the precision boot's shape provides. One
 * merged entry per script, with a real 0 or a real count on every range boot
 * ever saw, is what keeps the mapper's "missing" case for what it is actually
 * for: a script this never had a boot shape for at all.
 */
function mergeScript(boot: ScriptCoverage, delta: ScriptCoverage): ScriptCoverage {
  const byOffset = new Map<string, number>();
  for (const fn of delta.functions) {
    for (const r of fn.ranges) byOffset.set(`${r.startOffset}:${r.endOffset}`, r.count);
  }
  const functions = boot.functions.map((fn) => ({
    ...(fn.functionName !== undefined ? { functionName: fn.functionName } : {}),
    ranges: fn.ranges.map((r) => {
      const key = `${r.startOffset}:${r.endOffset}`;
      const count = byOffset.get(key);
      byOffset.delete(key); // consumed; whatever is left is boot never saw
      return {
        startOffset: r.startOffset,
        endOffset: r.endOffset,
        count: count ?? r.count,
      };
    }),
  }));
  // A range delta reports that boot's own shape never had -- code compiled
  // into an already-known script after boot, not just a function boot saw and
  // this window left untouched. Rare, and not something to drop: over-crediting
  // it is the safe direction, under-crediting it is not.
  if (byOffset.size > 0) {
    for (const fn of delta.functions) {
      const extra = fn.ranges.filter((r) =>
        byOffset.has(`${r.startOffset}:${r.endOffset}`),
      );
      if (extra.length > 0) {
        functions.push({
          ...(fn.functionName !== undefined ? { functionName: fn.functionName } : {}),
          ranges: extra,
        });
      }
    }
  }
  return { url: boot.url, functions };
}

/**
 * Union boot's shape with one window's delta, script by script. A script only
 * boot saw stands as boot left it (nothing ran there this window); a script
 * only this window saw is new since boot (a lazy `import()`, say) and V8 gives
 * it in full the first time, the same as boot's own first dump did, so it needs
 * no merge; a script both saw is merged range by range.
 */
function unionWithBoot(
  boot: ScriptCoverage[],
  delta: ScriptCoverage[],
): ScriptCoverage[] {
  const byUrl = new Map<string, ScriptCoverage>();
  for (const script of boot) byUrl.set(script.url, script);
  for (const script of delta) {
    const base = byUrl.get(script.url);
    byUrl.set(script.url, base === undefined ? script : mergeScript(base, script));
  }
  return [...byUrl.values()];
}

export class BootDeltaCoverage {
  private readonly dir: string;
  private readonly pid: number;
  private readonly trigger: CoverageDumpTrigger;
  private seen = new Set<string>();
  private boot: ScriptCoverage[] = [];
  private started = false;
  private inFlight = false;

  constructor(init: BootDeltaCoverageInit) {
    this.dir = init.dir;
    this.pid = init.pid;
    this.trigger = init.trigger;
  }

  /** Take the boot dump: everything compiled before the first window, un-run included. */
  async start(): Promise<void> {
    if (this.started) return;
    this.seen = dumpFiles(this.dir, true);
    this.boot = await this.nextDump();
    this.started = true;
  }

  /**
   * One window's delta, merged with boot's shape. Boot's un-run ranges carry a
   * real zero count in the merged result and contribute nothing on their own —
   * `toFiles`/`toBlocks` already skip a script with no executed range — so this
   * costs a cheap scan per call, not a duplicate recording of everything boot
   * loaded.
   */
  async endTest(): Promise<ScriptCoverage[]> {
    if (!this.started) {
      throw new Error('BootDeltaCoverage not started; call start() first');
    }
    const delta = await this.nextDump();
    return unionWithBoot(this.boot, delta);
  }

  private async nextDump(): Promise<ScriptCoverage[]> {
    if (this.inFlight) {
      throw new AmbiguousCoverageError(
        'a coverage window was still open when the next one started — two tests ' +
          'reading the same NODE_V8_COVERAGE directory at once cannot be told apart, so ' +
          'this fails rather than guessing which test the delta belongs to.',
      );
    }
    this.inFlight = true;
    try {
      await this.trigger();
      const now = dumpFiles(this.dir);
      const added = [...now].filter((f) => !this.seen.has(f));
      this.seen = now;
      const dump = ownDump(added, this.pid);
      return dump === '' ? [] : readScripts(join(this.dir, dump));
    } finally {
      this.inFlight = false;
    }
  }
}
