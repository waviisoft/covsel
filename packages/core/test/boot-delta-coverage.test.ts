import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AmbiguousCoverageError, BootDeltaCoverage } from '../src/boot-delta-coverage.js';

/**
 * The boot-delta bet: a process started with `NODE_V8_COVERAGE` has V8
 * collecting from bootstrap, so the very first `takeCoverage()` call sees
 * everything compiled so far — un-run functions included, at count 0 — and
 * every call after it is exactly the delta since the previous one. Union that
 * boot dump into every later window and a module loaded at boot keeps block
 * granularity instead of falling back to "the whole file ran". This suite
 * guards the mechanism two ways: against a real Node process for the actual V8
 * behaviour, and against a directory of hand-written dumps for the failure
 * paths a real process cannot reliably be made to hit (an ambiguous or
 * concurrent read).
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const driver = fileURLToPath(
  new URL('./fixtures/boot-delta-driver.mjs', import.meta.url),
);
const reuseDriver = fileURLToPath(
  new URL('./fixtures/boot-delta-driver-reuse.mjs', import.meta.url),
);

beforeAll(() => {
  if (!existsSync(coreDist)) {
    execSync('pnpm --filter @covsel/core build', { cwd: repoRoot, stdio: 'ignore' });
  }
}, 120_000);

describe('InspectorObserver in boot-delta mode', () => {
  it('credits boot to every test and keeps block granularity for the rest', () => {
    const covDir = mkdtempSync(join(tmpdir(), 'covsel-boot-delta-'));
    try {
      const res = spawnSync(process.execPath, [driver], {
        encoding: 'utf8',
        cwd: repoRoot,
        env: { ...process.env, NODE_V8_COVERAGE: covDir },
      });
      if (res.status !== 0) {
        throw new Error(`boot-delta driver failed:\n${res.stdout}${res.stderr}`);
      }
      const { t1, t2 } = JSON.parse(res.stdout.trim()) as {
        t1: { files: string[]; blockHashes: string[] };
        t2: { files: string[]; blockHashes: string[] };
      };

      // Both tests reached the module: the file-level view alone cannot tell
      // boot's contribution from either test's own call.
      expect(t1.files).toEqual(['module.mjs']);
      expect(t2.files).toEqual(['module.mjs']);

      // Block level is where boot crediting and per-test precision both show.
      // Boot ran `bootWork()` and the module's top-level statement that calls
      // it, before either test started, so both tests carry the same boot
      // blocks. Each test's own call is a block the other test does not have.
      // Neither carries a block for the function nobody ever called, which is
      // what would leak in if this had fallen back to file granularity.
      const common = t1.blockHashes.filter((h) => t2.blockHashes.includes(h));
      expect(common.length).toBeGreaterThan(0);

      const t1Own = t1.blockHashes.filter((h) => !t2.blockHashes.includes(h));
      const t2Own = t2.blockHashes.filter((h) => !t1.blockHashes.includes(h));
      expect(t1Own.length).toBe(1);
      expect(t2Own.length).toBe(1);

      // A never-called function contributes nothing: the total is boot's
      // shared blocks plus each test's own one, never the module's full set.
      expect(t1.blockHashes.length).toBe(common.length + 1);
      expect(t2.blockHashes.length).toBe(common.length + 1);
    } finally {
      rmSync(covDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('credits boot to a second observer instance in the same process, reading the first one’s marker rather than re-booting', () => {
    const covDir = mkdtempSync(join(tmpdir(), 'covsel-boot-delta-reuse-'));
    try {
      const res = spawnSync(process.execPath, [reuseDriver], {
        encoding: 'utf8',
        cwd: repoRoot,
        env: { ...process.env, NODE_V8_COVERAGE: covDir },
      });
      if (res.status !== 0) {
        throw new Error(`boot-delta reuse driver failed:\n${res.stdout}${res.stderr}`);
      }
      const { session1, session2 } = JSON.parse(res.stdout.trim()) as {
        session1: Record<string, number | undefined>;
        session2: Record<string, number | undefined>;
      };

      // bootWork ran once, at the process's real startup, before either
      // observer existed; neverCalled never ran at all. Both have to carry a
      // real count in session2 for the second observer to have read the
      // first one's marker correctly -- if it triggered its own "boot"
      // instead, that dump would be a plain delta since the first observer's
      // last one, which has no entry at all for either function, not even a
      // zero one, since neither was touched again in between.
      expect(session1.bootWork).toBe(1);
      expect(session1.neverCalled).toBe(0);
      expect(session2.bootWork).toBe(1);
      expect(session2.neverCalled).toBe(0);
      expect(session2.calledInTest1).toBe(0);
      expect(session2.calledInTest2).toBe(1);
    } finally {
      rmSync(covDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('BootDeltaCoverage', () => {
  let dir: string;

  // A real timestamp, not a synthetic one with a uniquifier tacked on: the
  // class itself now waits for the clock to move past the previous dump
  // before triggering the next (see the "waits for the clock" test below), so
  // two dumps this helper writes for the same pid and thread never collide on
  // one filename as long as both went through that wait -- and a tacked-on
  // suffix would only corrupt the timestamp field the wait itself reads.
  function writeDump(pid: number, threadId: number, scripts: unknown[] = []): void {
    const name = `coverage-${pid}-${Date.now()}-${threadId}.json`;
    writeFileSync(join(dir, name), JSON.stringify({ result: scripts }));
  }

  // The common case for these tests: nobody has ever booted this (fake)
  // process before, so there is no marker to read, and writing one is a
  // no-op the test does not care about.
  const noPriorMarker = {
    readBootMarker: async () => undefined,
    writeBootMarker: async () => {},
  };

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts cleanly when the directory does not exist yet, the way NODE_V8_COVERAGE leaves it until the first dump', async () => {
    // Node creates the NODE_V8_COVERAGE directory lazily, on its own first
    // write, not at process bootstrap -- so a target's very first dump can be
    // the thing that brings the directory into existence at all.
    dir = join(mkdtempSync(join(tmpdir(), 'covsel-bdc-')), 'not-yet-created');
    const pid = 4242;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        mkdirSync(dir, { recursive: true });
        writeDump(pid, 0, [{ url: 'file:///boot.js', functions: [] }]);
      },
    });
    await expect(bdc.start()).resolves.toBeUndefined();
  });

  it('fails loudly, rather than reading a window as empty, when the directory goes missing after boot', async () => {
    // Missing is only expected once: before this session has ever triggered a
    // dump. After that, an absent directory is a wrong path or a target that
    // stopped writing there -- reading it as "nothing ran" would silently
    // under-report every later window instead.
    const parent = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    dir = join(parent, 'vanishes');
    const pid = 4242;
    let calls = 0;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        calls++;
        if (calls === 1) {
          mkdirSync(dir, { recursive: true });
          writeDump(pid, 0, [{ url: 'file:///boot.js', functions: [] }]);
        } else {
          rmSync(dir, { recursive: true, force: true }); // gone by the next window
        }
      },
    });
    await bdc.start();
    await expect(bdc.endTest()).rejects.toThrow(
      /could not read the NODE_V8_COVERAGE directory/,
    );
    dir = parent; // let afterEach clean up what is left
  });

  it('reads the boot dump, then a clean delta per window, with no overlap', async () => {
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 4242;
    const scripts = [
      [{ url: 'file:///boot.js', functions: [] }],
      [{ url: 'file:///t1.js', functions: [] }],
      [{ url: 'file:///t2.js', functions: [] }],
    ];
    let call = 0;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        writeDump(pid, 0, scripts[call]);
        call++;
      },
    });

    await bdc.start();
    const first = await bdc.endTest();
    const second = await bdc.endTest();

    // Boot (call 0) is unioned into every window; each window's own delta
    // (calls 1 and 2) contributes exactly its own script, never the other's.
    expect(first.map((s) => s.url).sort()).toEqual(['file:///boot.js', 'file:///t1.js']);
    expect(second.map((s) => s.url).sort()).toEqual(['file:///boot.js', 'file:///t2.js']);
  });

  it('reads the dump the marker names as boot, rather than triggering a second one, when the process was already booted', async () => {
    // A previous recording already attached to this process, took its true
    // boot dump, and recorded that dump's own filename as the process's
    // marker -- a server left running (`reuseExistingServer`, a retried
    // worker) rather than one this session started itself.
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 500;
    const url = 'file:///module.js';
    const bootName = `coverage-${pid}-${Date.now()}-0.json`;
    writeFileSync(
      join(dir, bootName),
      JSON.stringify({
        result: [
          {
            url,
            functions: [
              {
                functionName: 'neverCalled',
                ranges: [{ startOffset: 0, endOffset: 10, count: 0 }],
              },
              {
                functionName: 'bootOnly',
                ranges: [{ startOffset: 20, endOffset: 30, count: 1 }],
              },
            ],
          },
        ],
      }),
    );
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      // Nothing new happens in this session's own window -- every trigger call
      // reports the script with no functions, the way a post-reset delta omits
      // anything untouched.
      trigger: async () => writeDump(pid, 0, [{ url, functions: [] }]),
      readBootMarker: async () => bootName,
      writeBootMarker: async () => {
        throw new Error('must not record a new marker when one is already set');
      },
    });
    await bdc.start();
    const result = await bdc.endTest();

    const [script] = result;
    const byName = new Map(
      script?.functions.map((fn) => [fn.functionName, fn.ranges[0]?.count]),
    );
    // `bootOnly` ran once, at the process's real startup, before this session
    // ever attached -- it has to survive from the marker-named dump start()
    // read directly. Triggering a fresh "boot" dump of its own here would see
    // only the delta off that earlier one (nothing, since nothing new ran) and
    // lose it silently.
    expect(byName.get('bootOnly')).toBe(1);
    expect(byName.get('neverCalled')).toBe(0);
  });

  it('waits past the latest of the pid’s existing dumps after reading a marker-named boot, not just past boot’s own timestamp', async () => {
    // A directory can hold more than one dump for the tracked pid by the time
    // a second session attaches: the marker names the boot dump specifically,
    // but the first session may also have taken test windows after it before
    // this session ever showed up. lastDumpTs has to guard against colliding
    // with the *latest* of those, not just with boot's own -- otherwise a
    // trigger right after start() could still land in the same millisecond as
    // one of them and silently overwrite it.
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 504;
    const bootName = `coverage-${pid}-${Date.now()}-0.json`;
    writeFileSync(join(dir, bootName), JSON.stringify({ result: [] }));
    // Implausibly far in the future: if lastDumpTs used only boot's own, real
    // timestamp, the next trigger would fire immediately, since real time
    // already exceeds that. Only reading the max forces it to actually wait.
    const future = Date.now() + 1_200;
    writeFileSync(
      join(dir, `coverage-${pid}-${future}-0.json`),
      JSON.stringify({ result: [] }),
    );

    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      readBootMarker: async () => bootName,
      writeBootMarker: async () => {},
      trigger: async () => writeDump(pid, 0, [{ url: 'file:///t.js', functions: [] }]),
    });
    await bdc.start();

    const started = Date.now();
    await bdc.endTest();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  }, 10_000);

  it('fails rather than silently re-booting, when the marker points at a boot dump the directory no longer has', async () => {
    // The coverage directory can be cleared between recordings while the
    // server itself stays up and keeps its marker -- e.g. a project resets
    // `.covsel/` before every `covsel record` invocation. Falling back to a
    // fresh trigger here would take a partial delta as boot, silently, which
    // is exactly the bug the marker exists to prevent.
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 502;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      trigger: async () => writeDump(pid, 0, [{ url: 'file:///boot.js', functions: [] }]),
      readBootMarker: async () => `coverage-${pid}-1700000000000-0.json`,
      writeBootMarker: async () => {},
    });
    await expect(bdc.start()).rejects.toThrow(AmbiguousCoverageError);
  });

  it('fails a second session, rather than silently re-booting, when the first session’s boot trigger reset counters but then failed', async () => {
    // takeCoverage() resets the target's counters as its very first act, so a
    // trigger that then fails to produce a dump this session can read -- a
    // foreign pid's dump landing in the same window, here -- still leaves the
    // process's counters reset. A session that attaches afterward and finds
    // no marker at all would trigger its own dump and read it as boot, but
    // that dump is only a delta off the counters the failed attempt already
    // reset -- exactly the bug the marker exists to prevent, just reached a
    // different way. The marker is claimed before the trigger runs, so this
    // has to fail closed instead.
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 503;
    // Stands in for the process's own memory: shared between two separate
    // BootDeltaCoverage instances the way globalThis is shared between two
    // sessions attaching to the same real process.
    let marker: string | undefined;
    const target = {
      readBootMarker: async () => marker,
      writeBootMarker: async (name: string) => {
        marker = name;
      },
    };

    const first = new BootDeltaCoverage({
      dir,
      pid,
      ...target,
      trigger: async () => writeDump(999, 0, []), // an untracked pid's dump
    });
    await expect(first.start()).rejects.toThrow(AmbiguousCoverageError);

    const second = new BootDeltaCoverage({
      dir,
      pid,
      ...target,
      trigger: async () => writeDump(pid, 0, [{ url: 'file:///boot.js', functions: [] }]),
    });
    await expect(second.start()).rejects.toThrow(AmbiguousCoverageError);
  });

  it('ignores a leftover dump from a dead process that reused this pid, when nothing marks it as boot', async () => {
    // The OS can reuse a pid after the process that held it exits. A leftover
    // dump from that dead process is not this one's boot shape, and nothing
    // marks it as such (this process has no marker of its own yet) -- reading
    // it anyway would credit every test with coverage from a process that no
    // longer exists.
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 501;
    const staleUrl = 'file:///dead-process-module.js';
    writeFileSync(
      join(dir, `coverage-${pid}-${Date.now() - 60_000}-0.json`),
      JSON.stringify({ result: [{ url: staleUrl, functions: [] }] }),
    );
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => writeDump(pid, 0, [{ url: 'file:///boot.js', functions: [] }]),
    });
    await bdc.start();
    const result = await bdc.endTest();
    expect(result.map((s) => s.url)).not.toContain(staleUrl);
    expect(result.map((s) => s.url)).toContain('file:///boot.js');
  });

  it('merges a window delta into boot’s shape for the same script, rather than handing both to the mapper as separate entries', async () => {
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 4242;
    const url = 'file:///module.js';
    // Boot's shape: three functions, none run yet (as the very first dump
    // reports them -- un-run, but present, at count 0).
    const bootScripts = [
      {
        url,
        functions: [
          {
            functionName: 'neverCalled',
            ranges: [{ startOffset: 0, endOffset: 10, count: 0 }],
          },
          {
            functionName: 'calledLater',
            ranges: [{ startOffset: 20, endOffset: 30, count: 0 }],
          },
        ],
      },
    ];
    // This window's own delta: only `calledLater` ran, so it is the only entry
    // -- `neverCalled` is not present at all, the same way a post-reset dump
    // omits anything with a zero delta.
    const deltaScripts = [
      {
        url,
        functions: [
          {
            functionName: 'calledLater',
            ranges: [{ startOffset: 20, endOffset: 30, count: 1 }],
          },
        ],
      },
    ];
    let call = 0;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        writeDump(pid, 0, call === 0 ? bootScripts : deltaScripts);
        call++;
      },
    });
    await bdc.start();
    const merged = await bdc.endTest();

    // One entry for the script, not two -- so the mapper's "no data for this
    // range at all" fallback (safe for a single, possibly-partial snapshot)
    // never gets asked about `neverCalled`, whose real answer boot already
    // knows: it did not run, in boot or in this window.
    expect(merged).toHaveLength(1);
    const [script] = merged;
    const byName = new Map(
      script?.functions.map((fn) => [fn.functionName, fn.ranges[0]?.count]),
    );
    expect(byName.get('neverCalled')).toBe(0);
    expect(byName.get('calledLater')).toBe(1);
  });

  it('credits a branch this window took even when V8 collapsed it into its enclosing range', async () => {
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 4242;
    const url = 'file:///branchy.js';
    // Boot's shape: a function with one branch inside it, neither run yet.
    const bootScripts = [
      {
        url,
        functions: [
          {
            functionName: 'withBranch',
            ranges: [
              { startOffset: 0, endOffset: 100, count: 0 },
              { startOffset: 10, endOffset: 20, count: 0 }, // the branch
            ],
          },
        ],
      },
    ];
    // This window's delta: the function ran 3 times, and the branch ran every
    // time too -- so V8 leaves the branch's own range out of the delta rather
    // than repeat a count identical to the range around it, reporting only
    // the enclosing range.
    const deltaScripts = [
      {
        url,
        functions: [
          {
            functionName: 'withBranch',
            ranges: [{ startOffset: 0, endOffset: 100, count: 3 }],
          },
        ],
      },
    ];
    let call = 0;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        writeDump(pid, 0, call === 0 ? bootScripts : deltaScripts);
        call++;
      },
    });
    await bdc.start();
    const merged = await bdc.endTest();

    const [script] = merged;
    const byRange = new Map(
      script?.functions
        .flatMap((fn) => fn.ranges)
        .map((r) => [`${r.startOffset}:${r.endOffset}`, r.count]),
    );
    // A plain fallback to boot's own count for a range missing from the delta
    // would read the branch as never taken this window -- 0, boot's count --
    // when it in fact ran every time the function did.
    expect(byRange.get('10:20')).toBe(3);
    expect(byRange.get('0:100')).toBe(3);
  });

  it('treats a window whose dump has an empty result as empty, not an error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 4242;
    let calls = 0;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        calls++;
        if (calls === 1) writeDump(pid, 0, [{ url: 'file:///boot.js', functions: [] }]);
        // A window with genuinely nothing new still gets a dump -- Node
        // writes one with an empty result rather than skipping the write.
        else writeDump(pid, 0, []);
      },
    });
    await bdc.start();

    const empty = await bdc.endTest();
    // Boot is still unioned in, even though this window's own delta was empty.
    expect(empty.map((s: { url: string }) => s.url)).toEqual(['file:///boot.js']);
  });

  it('fails a window whose trigger produced no dump at all, rather than reading it as empty', async () => {
    // Distinguishes a genuinely empty window (still gets a dump, covered
    // above) from a dropped one: a trigger that yields no new dump for the
    // tracked process at all -- the documented, if rare, failure mode of
    // calling takeCoverage() with no yield at all after a previous call.
    // Reading it as "ran nothing" would silently under-report.
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 4242;
    let calls = 0;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        calls++;
        if (calls === 1) writeDump(pid, 0, [{ url: 'file:///boot.js', functions: [] }]);
        // Every later call's dump is dropped before it reaches disk.
      },
    });
    await bdc.start();

    await expect(bdc.endTest()).rejects.toThrow(AmbiguousCoverageError);
  });

  it('fails start() itself, not only a later window, when the very first trigger produces no dump at all', async () => {
    // The same dropped-write failure mode as above, but caught at the boot
    // dump itself rather than at a window after it -- start()'s own trigger
    // call goes through the same ownDump() check as endTest()'s.
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 4343;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        // Dropped before it reached disk -- no dump at all, from the very
        // first call this session ever makes.
      },
    });
    await expect(bdc.start()).rejects.toThrow(AmbiguousCoverageError);
  });

  it('fails a window that sees a dump from a pid it was not told to track', async () => {
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const tracked = 100;
    const other = 200;
    let calls = 0;
    const bdc = new BootDeltaCoverage({
      dir,
      pid: tracked,
      ...noPriorMarker,
      trigger: async () => {
        calls++;
        writeDump(tracked, 0, []);
        // Only the window under test sees the foreign pid, so a clean boot
        // dump is what start() reads.
        if (calls > 1) writeDump(other, 0, []); // a worker/child sharing the directory
      },
    });
    await bdc.start();
    await expect(bdc.endTest()).rejects.toThrow(AmbiguousCoverageError);
  });

  it('fails a window that sees more than one dump from the tracked process', async () => {
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 300;
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        writeDump(pid, 0, []);
        writeDump(pid, 1, []); // e.g. a worker thread inside the tracked process
      },
    });
    await expect(bdc.start()).rejects.toThrow(AmbiguousCoverageError);
  });

  it('fails a window opened while a previous one has not resolved', async () => {
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 400;
    let calls = 0;
    let release: (() => void) | undefined;
    // Signals once the *second* trigger call has actually begun waiting, not
    // just been scheduled -- a window now waits for the clock to clear the
    // previous dump's own millisecond before it triggers at all (see "waits
    // for the clock" above), so this test cannot assume that call happens in
    // the same synchronous turn as starting the window it belongs to.
    let hanging: (() => void) | undefined;
    const isHanging = new Promise<void>((resolve) => {
      hanging = resolve;
    });
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        calls++;
        if (calls === 1) {
          writeDump(pid, 0, []); // a clean boot dump
          return;
        }
        // The first endTest()'s trigger hangs, so a second one started before
        // it resolves cannot be told apart from a genuinely concurrent test.
        hanging?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        writeDump(pid, 0, []);
      },
    });
    await bdc.start();

    const first = bdc.endTest();
    await expect(bdc.endTest()).rejects.toThrow(AmbiguousCoverageError);
    await isHanging;
    release?.();
    await first;
  });

  it('waits for the clock to move past the previous dump before triggering the next, so two never collide on one filename', async () => {
    // The real filename Node writes has no uniquifier beyond the millisecond
    // -- coverage-<pid>-<timestamp-ms>-<threadId>.json -- so a trigger that
    // fires again inside the same millisecond as the one before it would
    // silently overwrite that dump rather than produce a second, distinct
    // file. A trigger this fast and this synchronous is exactly the case a
    // real timer yield is not reliable insurance against.
    dir = mkdtempSync(join(tmpdir(), 'covsel-bdc-'));
    const pid = 700;
    const seen: number[] = [];
    const bdc = new BootDeltaCoverage({
      dir,
      pid,
      ...noPriorMarker,
      trigger: async () => {
        const ts = Date.now();
        seen.push(ts);
        writeFileSync(
          join(dir, `coverage-${pid}-${ts}-0.json`),
          JSON.stringify({ result: [] }),
        );
      },
    });
    await bdc.start();
    await bdc.endTest();
    await bdc.endTest();

    expect(new Set(seen).size).toBe(3);
  });
});
