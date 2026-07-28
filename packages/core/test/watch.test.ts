import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type AffectedResult,
  type CoverageMap,
  type CovselConfig,
  hashFileContents,
  MAP_SCHEMA_VERSION,
  OBSERVES_EVERYTHING,
  resolveConfig,
  type SelectInit,
  watchAffected,
  type WatchEvent,
  type WatchSourceFactory,
  type WatchSourceHandlers,
} from '../src/index.js';

/**
 * The watch loop's fail-open suite. A watch loop that quietly stops selecting is
 * the failure mode covsel exists to prevent, so every ambiguity here — selection
 * that throws, git that cannot answer, a watcher that dies, a change the
 * platform would not name — has to end in more tests running, or in the loop
 * saying loudly that it has stopped.
 */

const DEBOUNCE = 5;

/** A watch source under the test's control, standing in for the fs watcher. */
function fakeSource(): {
  factory: WatchSourceFactory;
  change(path?: string): void;
  fail(message: string): void;
  closed(): boolean;
} {
  let handlers: WatchSourceHandlers | undefined;
  let closed = false;
  return {
    factory: (_cwd, h) => {
      handlers = h;
      return {
        close: () => {
          closed = true;
        },
      };
    },
    change: (path) => handlers?.change(path),
    fail: (message) => handlers?.error(new Error(message)),
    closed: () => closed,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the watch loop');
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Let the debounce window pass and any queued cycle finish. */
async function quiesce(): Promise<void> {
  await new Promise((r) => setTimeout(r, DEBOUNCE * 8));
}

const NOTHING: AffectedResult = { fullRun: false, tests: [], selected: [] };

function selectedFile(file: string): AffectedResult {
  return { fullRun: false, tests: [file], selected: [{ file }] };
}

interface Harness {
  source: ReturnType<typeof fakeSource>;
  runs: AffectedResult[];
  events: WatchEvent[];
  stop(): Promise<number>;
}

/** Start a watch loop with a fake source, collecting every run and event. */
function start(
  cwd: string,
  overrides: Partial<Parameters<typeof watchAffected>[0]> & {
    config?: CovselConfig;
  } = {},
): Harness {
  const source = fakeSource();
  const runs: AffectedResult[] = [];
  const events: WatchEvent[] = [];
  const controller = new AbortController();
  const { config, ...rest } = overrides;

  const done = watchAffected({
    cwd,
    config: config ?? resolveConfig(),
    debounceMs: DEBOUNCE,
    createSource: source.factory,
    signal: controller.signal,
    onEvent: (e) => events.push(e),
    run: (selection) => {
      runs.push(selection);
      return 0;
    },
    ...rest,
  });

  return {
    source,
    runs,
    events,
    stop: async () => {
      controller.abort();
      return done;
    },
  };
}

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-watch-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('watchAffected', () => {
  it('runs once at startup so the first save is not the first signal', async () => {
    const h = start(tempDir(), { select: async () => NOTHING });
    await waitFor(() => h.runs.length === 1);
    expect(await h.stop()).toBe(0);
    expect(h.source.closed()).toBe(true);
  });

  it('waits for the first change when the initial run is off', async () => {
    const h = start(tempDir(), { select: async () => NOTHING, initialRun: false });
    await quiesce();
    expect(h.runs).toHaveLength(0);
    h.source.change('src/a.ts');
    await waitFor(() => h.runs.length === 1);
    await h.stop();
  });

  it('debounces a burst of writes into a single run', async () => {
    const h = start(tempDir(), { select: async () => NOTHING, initialRun: false });
    for (const file of ['src/a.ts', 'src/a.ts', 'src/b.ts', 'src/a.ts', 'src/c.ts']) {
      h.source.change(file);
    }
    await waitFor(() => h.runs.length === 1);
    await quiesce();
    expect(h.runs).toHaveLength(1);
    const change = h.events.find((e) => e.kind === 'change');
    expect(change?.kind === 'change' && change.paths.sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    await h.stop();
  });

  it('coalesces changes arriving mid-run into exactly one follow-up run', async () => {
    const source = fakeSource();
    const runs: AffectedResult[] = [];
    const controller = new AbortController();
    const done = watchAffected({
      cwd: tempDir(),
      config: resolveConfig(),
      debounceMs: DEBOUNCE,
      createSource: source.factory,
      signal: controller.signal,
      initialRun: false,
      select: async () => NOTHING,
      run: (selection) => {
        runs.push(selection);
        if (runs.length === 1) {
          source.change('src/during-1.ts');
          source.change('src/during-2.ts');
        }
        return 0;
      },
    });

    source.change('src/a.ts');
    await waitFor(() => runs.length === 2);
    await quiesce();
    expect(runs).toHaveLength(2);
    controller.abort();
    await done;
  });

  it('keeps watching after a run fails', async () => {
    const h = start(tempDir(), {
      select: async () => NOTHING,
      run: (selection) => {
        h.runs.push(selection);
        return 1;
      },
    });
    await waitFor(() => h.runs.length === 1);
    h.source.change('src/a.ts');
    await waitFor(() => h.runs.length === 2);
    expect(h.events.filter((e) => e.kind === 'ran').every((e) => e.code === 1)).toBe(
      true,
    );
    await h.stop();
  });

  it('keeps watching after a run throws, and says so', async () => {
    const h = start(tempDir(), {
      select: async () => NOTHING,
      run: (selection) => {
        h.runs.push(selection);
        if (h.runs.length === 1) throw new Error('spawn ENOENT');
        return 0;
      },
    });
    await waitFor(() => h.runs.length === 1);
    h.source.change('src/a.ts');
    await waitFor(() => h.runs.length === 2);
    const warning = h.events.find((e) => e.kind === 'warning');
    expect(warning?.kind === 'warning' && warning.reason).toContain('spawn ENOENT');
    await h.stop();
  });

  it('runs a change the watcher could not name rather than ignoring it', async () => {
    const h = start(tempDir(), { select: async () => NOTHING, initialRun: false });
    h.source.change(undefined);
    await waitFor(() => h.runs.length === 1);
    const change = h.events.find((e) => e.kind === 'change');
    expect(change?.kind === 'change' && change.unnamed).toBe(true);
    await h.stop();
  });

  it('never re-triggers on its own map writes', async () => {
    const config = resolveConfig({ store: { dir: 'custom-store' } });
    const h = start(tempDir(), {
      select: async () => NOTHING,
      initialRun: false,
      config,
    });
    h.source.change('custom-store/map.json');
    h.source.change('.git/index');
    h.source.change('node_modules/pkg/index.js');
    await quiesce();
    expect(h.runs).toHaveLength(0);
    h.source.change('src/a.ts');
    await waitFor(() => h.runs.length === 1);
    await h.stop();
  });

  it('stops loudly when the watcher dies instead of looking healthy', async () => {
    const h = start(tempDir(), { select: async () => NOTHING });
    await waitFor(() => h.runs.length === 1);
    h.source.fail('inotify watch limit reached');
    const code = await h.stop();
    expect(code).toBe(1);
    expect(h.source.closed()).toBe(true);
    const failed = h.events.find((e) => e.kind === 'watcher-failed');
    expect(failed?.kind === 'watcher-failed' && failed.reason).toContain('inotify');
  });

  it('stops with exit 1 when the watcher cannot be established at all', async () => {
    const events: WatchEvent[] = [];
    const code = await watchAffected({
      cwd: tempDir(),
      config: resolveConfig(),
      createSource: () => {
        throw new Error('ENOSPC');
      },
      run: () => 0,
      onEvent: (e) => events.push(e),
    });
    expect(code).toBe(1);
    expect(events.some((e) => e.kind === 'watcher-failed')).toBe(true);
  });

  describe('fail-open', () => {
    it('runs everything when selection throws', async () => {
      const cwd = tempDir();
      writeFileSync(join(cwd, 'a.test.js'), 'test\n');
      writeFileSync(join(cwd, 'b.test.js'), 'test\n');
      const h = start(cwd, {
        select: async () => {
          throw new Error('store exploded');
        },
      });
      await waitFor(() => h.runs.length === 1);
      const first = h.runs[0]!;
      expect(first.fullRun).toBe(true);
      expect(first.reason).toContain('store exploded');
      expect(first.tests.sort()).toEqual(['a.test.js', 'b.test.js']);
      await h.stop();
    });

    it('keeps falling open on every later change, not just the first', async () => {
      const h = start(tempDir(), {
        select: async () => {
          throw new Error('still broken');
        },
      });
      await waitFor(() => h.runs.length === 1);
      h.source.change('src/a.ts');
      await waitFor(() => h.runs.length === 2);
      expect(h.runs.every((r) => r.fullRun)).toBe(true);
      await h.stop();
    });

    it('runs everything when git is unavailable', async () => {
      // A directory that is not a work tree: the real selection path cannot
      // compute a diff, so it must not conclude that nothing is affected.
      const cwd = tempDir();
      writeFileSync(join(cwd, 'a.test.js'), 'test\n');
      const h = start(cwd);
      await waitFor(() => h.runs.length === 1);
      expect(h.runs[0]!.fullRun).toBe(true);
      expect(h.runs[0]!.reason).toBeDefined();
      await h.stop();
    });

    it('still triggers on a change when git cannot say whether it is ignored', async () => {
      const h = start(tempDir(), { initialRun: false });
      h.source.change('out/bundle.js');
      await waitFor(() => h.runs.length === 1);
      await h.stop();
    });
  });

  describe('in a real repository', () => {
    function git(cwd: string, args: string[]): void {
      const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    }

    /**
     * A committed fixture with a map recorded at HEAD covering `src/a.mjs` from
     * `test/a.test.mjs` only — `test/b.test.mjs` is deliberately absent from the
     * map, the way a newly added test is.
     */
    function fixture(): string {
      const cwd = tempDir();
      mkdirSync(join(cwd, 'src'));
      mkdirSync(join(cwd, 'test'));
      writeFileSync(join(cwd, 'src/a.mjs'), 'export const a = 1;\n');
      writeFileSync(join(cwd, 'src/b.mjs'), 'export const b = 2;\n');
      writeFileSync(join(cwd, 'test/a.test.mjs'), 'import "../src/a.mjs";\n');
      writeFileSync(join(cwd, 'test/b.test.mjs'), 'import "../src/b.mjs";\n');
      writeFileSync(join(cwd, 'package.json'), '{ "name": "fixture" }\n');
      writeFileSync(join(cwd, '.gitignore'), 'out/\n.covsel/\n');
      git(cwd, ['init', '-q']);
      git(cwd, ['config', 'user.email', 'test@example.com']);
      git(cwd, ['config', 'user.name', 'covsel test']);
      git(cwd, ['add', '.']);
      git(cwd, ['commit', '-q', '-m', 'fixture']);
      const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd,
        encoding: 'utf8',
      }).stdout.trim();

      const map: CoverageMap = {
        schemaVersion: MAP_SCHEMA_VERSION,
        granularity: 'file',
        commit,
        recordedAt: new Date().toISOString(),
        sentinelHashes: {},
        // The fixture's recording saw the whole repo, so a change anywhere is a
        // change the map has something to say about — these tests are about the
        // watch loop, not about unobserved-scope fall-open.
        observed: [...OBSERVES_EVERYTHING],
        entries: [
          {
            test: { file: 'test/a.test.mjs' },
            files: [
              { file: 'src/a.mjs', fileHash: hashFileContents(join(cwd, 'src/a.mjs')) },
            ],
          },
        ],
      };
      mkdirSync(join(cwd, '.covsel'));
      writeFileSync(join(cwd, '.covsel/map.json'), JSON.stringify(map));
      return cwd;
    }

    const config = resolveConfig({
      testGlobs: ['**/*.test.mjs'],
      granularity: 'file',
    });

    it('selects the tests a source change affects', async () => {
      const cwd = fixture();
      const h = start(cwd, { config, initialRun: false });
      writeFileSync(join(cwd, 'src/a.mjs'), 'export const a = 99;\n');
      h.source.change('src/a.mjs');
      await waitFor(() => h.runs.length === 1);
      const selection = h.runs[0]!;
      expect(selection.fullRun).toBe(false);
      // b.test.mjs is unmapped, so it always runs; a.test.mjs is selected by the
      // change itself.
      expect(selection.tests).toContain('test/a.test.mjs');
      await h.stop();
    });

    it('always runs a changed test file the map never saw', async () => {
      const cwd = fixture();
      const h = start(cwd, { config, initialRun: false });
      writeFileSync(join(cwd, 'test/b.test.mjs'), 'import "../src/b.mjs";\n// edit\n');
      h.source.change('test/b.test.mjs');
      await waitFor(() => h.runs.length === 1);
      expect(h.runs[0]!.tests).toContain('test/b.test.mjs');
      await h.stop();
    });

    it('runs everything when a sentinel changes', async () => {
      const cwd = fixture();
      const h = start(cwd, { config, initialRun: false });
      writeFileSync(join(cwd, 'package.json'), '{ "name": "fixture", "version": "1" }\n');
      h.source.change('package.json');
      await waitFor(() => h.runs.length === 1);
      expect(h.runs[0]!.fullRun).toBe(true);
      expect(h.runs[0]!.reason).toContain('package.json');
      await h.stop();
    });

    it('runs everything when the map is unreadable', async () => {
      const cwd = fixture();
      writeFileSync(join(cwd, '.covsel/map.json'), 'not json at all');
      const h = start(cwd, { config, initialRun: false });
      h.source.change('src/a.mjs');
      await waitFor(() => h.runs.length === 1);
      expect(h.runs[0]!.fullRun).toBe(true);
      await h.stop();
    });

    it('triggers on an untracked path git does not ignore', async () => {
      // A file the runner itself wrote is indistinguishable from one the user
      // wrote, and it does show up in the diff, so it has to be acted on.
      const cwd = fixture();
      const h = start(cwd, { config, initialRun: false });
      writeFileSync(join(cwd, 'report.txt'), 'run report\n');
      h.source.change('report.txt');
      await waitFor(() => h.runs.length === 1);
      await h.stop();
    });

    it('ignores writes to gitignored paths but not to tracked ones', async () => {
      const cwd = fixture();
      const h = start(cwd, { config, initialRun: false });
      mkdirSync(join(cwd, 'out'));
      writeFileSync(join(cwd, 'out/bundle.js'), 'built\n');
      h.source.change('out/bundle.js');
      await quiesce();
      expect(h.runs).toHaveLength(0);
      h.source.change('src/a.mjs');
      await waitFor(() => h.runs.length === 1);
      await h.stop();
    });
  });

  it('picks up a real write through the default fs watcher', async () => {
    const cwd = tempDir();
    const runs: AffectedResult[] = [];
    const controller = new AbortController();
    const done = watchAffected({
      cwd,
      config: resolveConfig(),
      debounceMs: 20,
      initialRun: false,
      signal: controller.signal,
      select: async () => NOTHING,
      run: (selection) => {
        runs.push(selection);
        return 0;
      },
    });
    // The watcher is established synchronously, before the first await.
    writeFileSync(join(cwd, 'a.test.js'), 'first\n');
    await waitFor(() => runs.length >= 1, 10_000);
    controller.abort();
    await done;
  }, 15_000);

  describe('re-recording', () => {
    it('does not touch the map by default', async () => {
      const h = start(tempDir(), { select: async () => NOTHING });
      await waitFor(() => h.runs.length === 1);
      await h.stop();
      expect(h.events.some((e) => e.kind === 'recorded')).toBe(false);
    });

    it('re-records after a run that passes', async () => {
      let records = 0;
      const h = start(tempDir(), {
        select: async () => selectedFile('a.test.js'),
        record: async () => {
          records++;
          return { ok: true };
        },
      });
      await waitFor(() => records === 1);
      await h.stop();
      expect(h.events.some((e) => e.kind === 'recorded' && e.ok)).toBe(true);
    });

    it('leaves the map alone after a run that fails', async () => {
      let records = 0;
      const h = start(tempDir(), {
        select: async () => selectedFile('a.test.js'),
        run: () => 1,
        record: async () => {
          records++;
          return { ok: true };
        },
      });
      await waitFor(() => h.events.some((e) => e.kind === 'ran'));
      await quiesce();
      expect(records).toBe(0);
      await h.stop();
    });

    it('keeps watching when re-recording fails', async () => {
      const runs: AffectedResult[] = [];
      const source = fakeSource();
      const events: WatchEvent[] = [];
      const controller = new AbortController();
      const done = watchAffected({
        cwd: tempDir(),
        config: resolveConfig(),
        debounceMs: DEBOUNCE,
        createSource: source.factory,
        signal: controller.signal,
        onEvent: (e) => events.push(e),
        select: async (_init: SelectInit) => selectedFile('a.test.js'),
        record: async () => {
          throw new Error('recorder blew up');
        },
        run: (selection) => {
          runs.push(selection);
          return 0;
        },
      });
      await waitFor(() => runs.length === 1);
      source.change('src/a.ts');
      await waitFor(() => runs.length === 2);
      const recorded = events.find((e) => e.kind === 'recorded');
      expect(recorded?.kind === 'recorded' && recorded.ok).toBe(false);
      controller.abort();
      await done;
    });
  });
});
