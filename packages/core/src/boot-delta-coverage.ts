/**
 * Boot + per-window delta coverage, read from a `NODE_V8_COVERAGE` directory.
 *
 * A process started with `NODE_V8_COVERAGE=<dir>` (and, for a process covsel
 * cannot spawn itself, `--inspect`) has V8 collecting precise, block-level
 * coverage for every function from the moment it starts — including the ones
 * a module loaded at boot never runs. `start()` takes the boot dump: the very
 * first one ever taken for the process, which is the one that sees everything
 * compiled so far, with an un-run function reported at count 0 rather than
 * absent. A second session can attach to the same already-running process
 * later — the target may be a server a previous recording already attached
 * to and left running (`reuseExistingServer`, a retried worker) — so
 * `start()` has the target remember, in its own memory, whether it has
 * already been booted, rather than inferring it from the coverage directory
 * or the clock: neither survives a laptop sleeping between recordings
 * (`process.uptime()` pauses while asleep, the wall clock does not) or the
 * directory being cleared while the process stays up, and both of those
 * silently produce the exact bug this exists to prevent — a partial dump
 * read as if it were the whole boot shape. A target that already has the
 * marker set reads the dump it names as boot instead of triggering a second
 * one that would only be a delta off it; if that dump has gone missing, the
 * recording fails rather than silently falling back to a fresh, partial one.
 * Boot code runs before every window and for every window, so it is unioned
 * into each one's result.
 *
 * Every window after that is exactly what changed since the previous dump —
 * Node resets the counters on each `takeCoverage()` call, so windows never
 * overlap. A dump this cannot attribute — none where one was expected, more
 * than one, or one from a pid it was not told to track (a worker or a child
 * process that inherited the same directory) — fails the window rather than
 * guessing which test it belongs to, the same standard the per-test inspector
 * session already holds itself to. That only catches a worker or child that
 * actually writes a dump into the directory, which a short-lived one does on
 * exit even with nothing in it calling `takeCoverage()` itself; one that
 * outlives the recording never writes one during it, so there is no dump to
 * catch and its execution is simply absent from every test's coverage rather
 * than failing loudly — the same gap this class's callers already had when
 * they could only reach the tracked process's own isolate at all.
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
import { setTimeout as delay } from 'node:timers/promises';

import type { ScriptCoverage } from './observer.js';

/** Asks the target to write its next coverage dump and resolves once it has. */
export type CoverageDumpTrigger = () => Promise<void>;

/**
 * The global-symbol-registry key a target's boot marker is stored under —
 * shared so an in-process reader and a remote `Runtime.evaluate` reader agree
 * on the exact same property without either hardcoding a string the other
 * could drift from.
 */
export const BOOT_MARKER_KEY = 'covsel.bootDump';

/**
 * A placeholder `writeBootMarker` value, claimed before the boot trigger runs
 * rather than after it succeeds — see `start()`. Never a real dump's
 * filename, so a marker still set to it reads as "boot never finished",
 * failing the same way a marker pointing at a genuinely missing file does.
 */
const PENDING_BOOT_MARKER = 'pending';

export interface BootDeltaCoverageInit {
  /** Directory the target was started with `NODE_V8_COVERAGE` pointed at. */
  dir: string;
  /** The target's process id, so a dump from an untracked process or thread is caught. */
  pid: number;
  /** Triggers one `node:v8` `takeCoverage()` call in the target. */
  trigger: CoverageDumpTrigger;
  /**
   * Reads the boot dump's filename back from the target's own memory (e.g.
   * `globalThis[Symbol.for('covsel.bootDump')]`), or `undefined` if this
   * process has never taken one.
   */
  readBootMarker: () => Promise<string | undefined>;
  /**
   * Records the boot dump's filename in the target's own memory, once `start()`
   * has taken it, so a later session attaching to this same process can read
   * it back instead of mistaking its own first dump for boot.
   */
  writeBootMarker: (dumpName: string) => Promise<void>;
}

/** A dump this could not attribute to the tracked process's main thread alone. */
export class AmbiguousCoverageError extends Error {}

const DUMP_NAME = /^coverage-(\d+)-(\d+)-(\d+)\.json$/;

/** The epoch-ms a dump's own filename was written with, or `undefined` for a non-dump name. */
function dumpTimestamp(name: string): number | undefined {
  const match = DUMP_NAME.exec(name);
  return match === null ? undefined : Number(match[2]);
}

/**
 * The latest timestamp among the tracked process's own already-existing
 * main-thread dumps, so a session that reads a marker-named boot dump still
 * waits past whatever the process's *other* prior dumps already used, not
 * only past boot's own — an earlier session's later test windows leave dumps
 * newer than its boot capture, and colliding with one of those is exactly as
 * real a risk as colliding with boot's.
 */
function maxOwnDumpTs(files: Iterable<string>, pid: number): number | undefined {
  let max: number | undefined;
  for (const name of files) {
    const match = DUMP_NAME.exec(name);
    if (match === null) continue;
    const [, filePid, ts, threadId] = match;
    if (filePid !== String(pid) || threadId !== '0') continue;
    const timestamp = Number(ts);
    if (max === undefined || timestamp > max) max = timestamp;
  }
  return max;
}

/**
 * Waits, if it has to, until the clock has moved past a previous dump's own
 * timestamp — never before the first dump this session ever triggers, which
 * has no previous one to collide with.
 *
 * The dump filename is `coverage-<pid>-<timestamp-ms>-<threadId>.json`, so two
 * dumps written in the same millisecond collide on the same name and the
 * second silently overwrites the first. A yield to the event loop after
 * triggering is not enough insurance against that — nothing requires it to
 * take any real time at all — so this waits on the one thing that actually
 * prevents the collision: the millisecond itself moving on.
 */
async function waitPast(ts: number | undefined): Promise<void> {
  if (ts === undefined) return;
  while (Date.now() <= ts) await delay(1);
}

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
    const threadId = match?.[3];
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
  const [dump] = mine;
  if (dump === undefined) {
    // A window with genuinely nothing new still gets a dump -- Node writes one
    // with an empty `result` rather than skipping the write. No dump at all
    // most likely means two dumps landed in the same millisecond: the
    // filename is coverage-<pid>-<ms>-0.json, so the second write silently
    // overwrites the first, and the overwritten name is already in `seen` --
    // indistinguishable from here whether this window's own write was the one
    // lost or folded into the next one instead. Reading it as "this window ran
    // nothing" would silently under-report; failing is the only reading that
    // does not guess.
    throw new AmbiguousCoverageError(
      `a coverage window produced no dump for the tracked process at all, where a ` +
        'window with nothing new is still expected to write one (with an empty ' +
        'result). The most likely cause is a same-millisecond filename collision — ' +
        'two dumps landing in the same coverage-<pid>-<ms>-0.json name, with the ' +
        'second silently overwriting the first rather than the trigger genuinely ' +
        'failing to write — but either way there is no telling whether this ' +
        'window ran nothing or its dump went missing, and recording it as empty ' +
        'would guess.',
    );
  }
  return dump;
}

function readScripts(path: string): ScriptCoverage[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { result?: ScriptCoverage[] };
  return parsed.result ?? [];
}

/**
 * The delta range that implicitly covers `startOffset:endOffset` when no
 * range reports that exact span — the narrowest one that contains it. V8
 * omits a nested range from a delta not only when it never ran (the case
 * `mergeScript`'s fallback to boot's own count is for), but also when it ran
 * exactly as many times as the range around it: reporting the parent already
 * says everything inside it ran that many times too, so a strictly-narrower
 * child at the same count is redundant and left out. The narrowest containing
 * range is that parent (or, if it too was collapsed into one narrower than
 * itself, that one) — never the range itself, an exact span is handled by the
 * caller's own offset lookup first.
 */
function enclosingDeltaCount(
  ranges: { startOffset: number; endOffset: number; count: number }[],
  startOffset: number,
  endOffset: number,
): number | undefined {
  let best: { startOffset: number; endOffset: number; count: number } | undefined;
  for (const r of ranges) {
    if (r.startOffset > startOffset || r.endOffset < endOffset) continue;
    if (r.startOffset === startOffset && r.endOffset === endOffset) continue;
    if (
      best === undefined ||
      r.endOffset - r.startOffset < best.endOffset - best.startOffset
    ) {
      best = r;
    }
  }
  return best?.count;
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
 *
 * A range boot saw that has no exact match in the delta is not automatically
 * a range this window left untouched, though — see `enclosingDeltaCount` for
 * the other reason V8 leaves one out. The count from whichever containing
 * range the delta does report, maxed with boot's own (never lower, since
 * under-crediting is the direction that is never safe), is what a plain
 * fallback to boot's count alone would get wrong for a branch this window did
 * take.
 */
function mergeScript(boot: ScriptCoverage, delta: ScriptCoverage): ScriptCoverage {
  const byOffset = new Map<string, number>();
  const deltaRanges: { startOffset: number; endOffset: number; count: number }[] = [];
  for (const fn of delta.functions) {
    for (const r of fn.ranges) {
      byOffset.set(`${r.startOffset}:${r.endOffset}`, r.count);
      deltaRanges.push(r);
    }
  }
  const functions = boot.functions.map((fn) => ({
    ...(fn.functionName !== undefined ? { functionName: fn.functionName } : {}),
    ranges: fn.ranges.map((r) => {
      const key = `${r.startOffset}:${r.endOffset}`;
      const exact = byOffset.get(key);
      byOffset.delete(key); // consumed; whatever is left is boot never saw
      const implied = enclosingDeltaCount(deltaRanges, r.startOffset, r.endOffset);
      const count =
        exact ?? (implied === undefined ? r.count : Math.max(implied, r.count));
      return {
        startOffset: r.startOffset,
        endOffset: r.endOffset,
        count,
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
  private readonly readBootMarker: () => Promise<string | undefined>;
  private readonly writeBootMarker: (dumpName: string) => Promise<void>;
  private seen = new Set<string>();
  private boot: ScriptCoverage[] = [];
  private started = false;
  private inFlight = false;
  /** The most recent dump's own timestamp, so the next trigger waits past it. */
  private lastDumpTs: number | undefined;

  constructor(init: BootDeltaCoverageInit) {
    this.dir = init.dir;
    this.pid = init.pid;
    this.trigger = init.trigger;
    this.readBootMarker = init.readBootMarker;
    this.writeBootMarker = init.writeBootMarker;
  }

  /**
   * Take the boot dump: everything compiled before the first window, un-run
   * included. If the target's own marker says a previous session already took
   * one, that dump — not one this triggers now, which would only be a delta
   * off it — is the true boot shape, and this reads it directly; a marker
   * pointing at a dump the directory no longer has fails the recording rather
   * than silently falling back to a fresh, partial capture.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.seen = dumpFiles(this.dir, true);
    const marker = await this.readBootMarker();
    if (marker === undefined) {
      // Claimed before the trigger runs, not after it succeeds: `takeCoverage()`
      // resets the target's counters as its very first act, so once this
      // session triggers one there is no way back to a genuine boot shape for
      // this process even if this call then fails itself (a foreign dump
      // landing in the same window, a parse failure, the process dying). A
      // session that attaches afterward has to see that a boot was claimed and
      // never finished, not find no marker at all and trigger its own --
      // which would only be a delta off the one this call already reset.
      await this.writeBootMarker(PENDING_BOOT_MARKER);
      const first = await this.nextDump();
      this.boot = first.scripts;
      await this.writeBootMarker(first.name);
    } else {
      if (!this.seen.has(marker)) {
        throw new AmbiguousCoverageError(
          `this process already claimed a boot dump (${marker}) during an earlier ` +
            "session, but the coverage directory doesn't have it -- either that " +
            'session’s own boot attempt never finished (its trigger failed, or the ' +
            'process died, after counters were already reset), or the directory was ' +
            'cleared while the process stayed up. Either way there is nothing to ' +
            're-derive a boot shape from, so this fails rather than triggering a fresh ' +
            'dump and reading a partial capture as if it were the whole thing.',
        );
      }
      this.boot = readScripts(join(this.dir, marker));
      this.lastDumpTs = maxOwnDumpTs(this.seen, this.pid);
    }
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
    return unionWithBoot(this.boot, delta.scripts);
  }

  private async nextDump(): Promise<{ name: string; scripts: ScriptCoverage[] }> {
    if (this.inFlight) {
      throw new AmbiguousCoverageError(
        'a coverage window was still open when the next one started — two tests ' +
          'reading the same NODE_V8_COVERAGE directory at once cannot be told apart, so ' +
          'this fails rather than guessing which test the delta belongs to.',
      );
    }
    this.inFlight = true;
    try {
      await waitPast(this.lastDumpTs);
      await this.trigger();
      const now = dumpFiles(this.dir);
      const added = [...now].filter((f) => !this.seen.has(f));
      this.seen = now;
      const dump = ownDump(added, this.pid);
      this.lastDumpTs = dumpTimestamp(dump);
      return { name: dump, scripts: readScripts(join(this.dir, dump)) };
    } finally {
      this.inFlight = false;
    }
  }
}
