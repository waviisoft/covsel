/**
 * The Playwright side of the adapter: an auto-fixture that records what each
 * test executed *in the browser*.
 *
 * It is the user's own `test` object that gets extended, by a line they write:
 *
 * ```ts
 * import { test as base } from '@playwright/test';
 * import { covselFixtures } from '@covsel/adapter-playwright/fixture';
 *
 * export const test = base.extend(covselFixtures());
 * ```
 *
 * Explicit rather than injected. Playwright resolves fixtures through the `test`
 * object a spec imports, so injecting one from outside would mean reaching into
 * the user's config or their module graph — machinery that breaks on a Playwright
 * upgrade, in a way whose only symptom is a recording that quietly observes less
 * than it did before. One line the user can read is worth more than that.
 *
 * Outside a recording the returned object is empty, so `test` is exactly what it
 * was: no fixture, no browser coverage, nothing to pay for on the selected runs
 * that make up almost every invocation.
 *
 * The mapping happens here, in the Playwright worker, rather than back in
 * covsel's process. A dev server's bundle is often reachable only over HTTP while
 * that server is up, and the server is up exactly while the run is — so this is
 * where the coverage can still be resolved to the sources behind it.
 */
import { appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  type MapperConfig,
  type ScriptCoverage,
  UnmappableScriptError,
  V8FileMapper,
} from '@covsel/core';

import { RemoteBootDeltaSession, RemoteCoverageSession } from './server-session.js';

import {
  BLOCKS_ENV,
  CONFIG_ENV,
  CWD_ENV,
  type FailedWindow,
  type ObservedTest,
  type ObservedWindow,
  OUT_DIR_ENV,
} from './protocol.js';

/**
 * Chromium's JS coverage API, as much of it as this uses.
 *
 * Declared structurally rather than imported: Playwright is a peer dependency,
 * so this package compiles without it, and a structural type also lets the
 * fixture ask at runtime whether the browser under test has the API at all.
 */
export interface CoverageApi {
  startJSCoverage(options?: { resetOnNavigation?: boolean }): Promise<void>;
  stopJSCoverage(): Promise<
    {
      url: string;
      source?: string;
      functions: {
        functionName?: string;
        ranges: { startOffset: number; endOffset: number; count: number }[];
      }[];
    }[]
  >;
}

/** The context a page belongs to, as much of it as this uses. */
export interface ContextLike {
  on(event: 'page', listener: (page: never) => void): unknown;
}

/** Playwright's `page` fixture, as much of it as this uses. */
export interface PageLike {
  /** Present on Chromium; absent on Firefox and WebKit, which is checked. */
  coverage?: CoverageApi;
  context(): ContextLike;
}

/** Playwright's `testInfo`, as much of it as this uses. */
export interface TestInfoLike {
  /** Absolute path of the spec file. */
  file: string;
  /** File, describes, and title — what `--grep` is matched against, less the project. */
  titlePath: string[];
  /** Which parallel slot ran this test; 0 when the run has only one. */
  parallelIndex?: number;
}

/** Playwright's `workerInfo`, as much of it as this uses. */
export interface WorkerInfoLike {
  /** Which parallel slot this worker is; 0 when the run has only one. */
  parallelIndex?: number;
}

/** Node's own default when `--inspect` is given no port. */
const DEFAULT_INSPECT_URL = 'http://127.0.0.1:9229';

/** Observing the application server the page talks to. */
export interface CovselServerWindow {
  /**
   * Repo globs this window can see — the server's own sources, and whatever they
   * reach. Read as written and never widened, like every scope covsel records.
   */
  readonly observes: readonly string[];
  /**
   * Where the server's Node inspector is listening. Defaults to Node's own
   * default port, which `--inspect` with no argument uses.
   */
  readonly inspectUrl?: string;
  /**
   * Directory the server was started with `NODE_V8_COVERAGE` pointed at.
   *
   * When set, the server window is one boot dump plus one delta per test read
   * from that directory over the inspector, instead of a fresh per-test
   * session — which keeps block granularity for modules the server loads at
   * boot, not just for ones a test loads on demand. Requires the server on
   * Node ≥22.3 (`process.getBuiltinModule`) and a filesystem this process can
   * read the directory from, true whenever the server and the recording share
   * a host, which a local `webServer` always does.
   *
   * Left unset, the server window falls back to a session opened fresh inside
   * each test and closed at its end, the same as before this existed — coverage
   * was not running before that session started, so a module the server loaded
   * at boot keeps only file granularity.
   */
  readonly coverageDir?: string;
}

/** What to observe, beyond the browser. */
export interface CovselFixturesOptions {
  /**
   * The browser window's own scope. Required whenever `server` is given, and
   * pointless without it: with one window the recorder's declaration is the
   * whole truth, and with two neither may claim the other's paths.
   */
  readonly browser?: { readonly observes: readonly string[] };
  /**
   * Observe the application server as well, so a change to it selects the tests
   * that reached it instead of falling open to a full run.
   *
   * Needs the server started with Node's inspector open (`--inspect`) and the
   * recording run with `--workers=1`: coverage is collected from the one server
   * process, and a second worker's test executing in it at the same time would
   * be credited to this one — or worse, would stop this one's collection
   * mid-test. The fixture refuses rather than guess which happened.
   */
  readonly server?: CovselServerWindow;
}

/** The auto-fixture, in the tuple form `test.extend` takes. */
export type CovselFixture = [
  (
    args: { page: PageLike; covselServerSession?: ServerSessionHandle },
    use: (value: void) => Promise<void>,
    testInfo: TestInfoLike,
  ) => Promise<void>,
  { auto: true },
];

/** The worker-scoped server session fixture, in the tuple form `test.extend` takes. */
export type CovselServerSessionFixture = [
  (
    args: Record<string, never>,
    use: (value: ServerSessionHandle | undefined) => Promise<void>,
    workerInfo: WorkerInfoLike,
  ) => Promise<void>,
  { scope: 'worker' },
];

/** What `covselFixtures()` returns: the fixtures, or nothing outside a recording. */
export interface CovselFixtures {
  covselCoverage?: CovselFixture;
  covselServerSession?: CovselServerSessionFixture;
}

/**
 * One mapper per worker, so the source-map resolver's cache spans the worker's
 * tests. A dev server's modules are the same modules for every test, and
 * resolving them once instead of once per test is the difference between a
 * recording that finishes and one nobody waits for.
 */
let shared: { mapper: V8FileMapper; wantBlocks: boolean } | undefined;
function mapper(): { mapper: V8FileMapper; wantBlocks: boolean } {
  if (shared !== undefined) return shared;
  const cwd = process.env[CWD_ENV] ?? process.cwd();
  // The mapper's own configuration, carried whole. Defaults here cover only a
  // missing variable: a project's `sourceMaps` settings arrive as given, since a
  // mapper that quietly lost them would fail every recording against a build the
  // project had already accepted.
  const config = JSON.parse(process.env[CONFIG_ENV] ?? '{}') as Partial<MapperConfig>;
  shared = {
    mapper: new V8FileMapper({
      cwd,
      config: {
        ...config,
        sourceGlobs: config.sourceGlobs ?? ['**/*'],
        testGlobs: config.testGlobs ?? [],
      },
    }),
    wantBlocks: process.env[BLOCKS_ENV] === '1',
  };
  return shared;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open the server's profiler for one test.
 *
 * A connection per test rather than one per worker, and precise coverage started
 * inside it: what comes back is then what this test made the server do, with no
 * baseline to subtract and nothing of the previous test left in it. It also means
 * no socket outlives the test that opened it, which matters in a Playwright
 * worker — an open one would keep the process from exiting.
 */
async function openServer(
  config: CovselServerWindow,
  testInfo: TestInfoLike,
): Promise<{ session: RemoteCoverageSession } | FailedWindow> {
  if ((testInfo.parallelIndex ?? 0) !== 0) {
    return {
      failed:
        'this test ran in a second Playwright worker, and the server window is ' +
        'collected from the one server process both of them drive. Another ' +
        'worker\u2019s test executing there at the same time would be credited to ' +
        'this one, and its own collection could be stopped mid-test \u2014 which ' +
        'records a test as covering less of the server than it does. Record with ' +
        '`--workers=1`. Only the recording is serial; the selected runs afterwards ' +
        'are not.',
    };
  }
  const session = new RemoteCoverageSession(config.inspectUrl ?? DEFAULT_INSPECT_URL);
  try {
    await session.start();
    return { session };
  } catch (err) {
    await session.close();
    return { failed: reason(err) };
  }
}

/**
 * Map what the server ran to its sources — the tail both server sessions share,
 * once each has its own scripts in hand.
 */
async function mapServerScripts(
  scripts: ScriptCoverage[],
  config: CovselServerWindow,
): Promise<{ window: ObservedWindow | FailedWindow; allowedUnmappable: string[] }> {
  const { mapper: m, wantBlocks } = mapper();
  const raw = { scripts };
  try {
    // The server executes its own files, so these are `file://` paths and the V8
    // offsets index the bytes on disk — no projection, and real block
    // granularity without the build having to publish anything.
    const files = await m.toFiles(raw);
    const blocks = wantBlocks ? await m.toBlocks(raw) : [];
    return {
      window: { files, blocks, observes: config.observes },
      allowedUnmappable: m.takeAllowedUnmappable(),
    };
  } catch (err) {
    return {
      window: {
        failed: err instanceof UnmappableScriptError ? err.message : reason(err),
      },
      allowedUnmappable: m.takeAllowedUnmappable(),
    };
  }
}

/** Take what the server ran during the test, and map it back to its sources. */
async function closeServer(
  session: RemoteCoverageSession,
  config: CovselServerWindow,
): Promise<{ window: ObservedWindow | FailedWindow; allowedUnmappable: string[] }> {
  let scripts: ScriptCoverage[];
  try {
    scripts = await session.take();
  } catch (err) {
    return { window: { failed: reason(err) }, allowedUnmappable: [] };
  } finally {
    await session.close();
  }
  return mapServerScripts(scripts, config);
}

/** This test's boot-delta server window: its own delta unioned with boot. */
async function closeServerBootDelta(
  session: RemoteBootDeltaSession,
  config: CovselServerWindow,
): Promise<{ window: ObservedWindow | FailedWindow; allowedUnmappable: string[] }> {
  let scripts: ScriptCoverage[];
  try {
    scripts = await session.endTest();
  } catch (err) {
    return { window: { failed: reason(err) }, allowedUnmappable: [] };
  }
  return mapServerScripts(scripts, config);
}

/** What the worker-scoped boot-delta session fixture yields. */
export type ServerSessionHandle =
  { readonly session: RemoteBootDeltaSession } | FailedWindow;

/** True when a handle carries a usable session rather than a failure. */
function hasSession(
  handle: ServerSessionHandle,
): handle is { readonly session: RemoteBootDeltaSession } {
  return 'session' in handle;
}

/**
 * The server's boot-delta coverage session, opened once per worker rather than
 * once per test.
 *
 * Boot has to be read before the first test, and every later window is a delta
 * off the one collection this keeps running — reopening it per test the way the
 * legacy session does would lose the running counters and reset `takeCoverage`'s
 * baseline along with them. Only instantiated when `server.coverageDir` is
 * configured; a recording without it, or without a server window at all, never
 * pays for this beyond the one no-op below.
 */
function serverSessionFixture(
  options: CovselFixturesOptions,
): CovselServerSessionFixture {
  return [
    // Playwright inspects a fixture function's own source to work out which
    // fixtures it depends on, and requires the first parameter to be written as
    // an object destructuring pattern even when nothing is destructured from it
    // -- a plain identifier here fails at fixture resolution, before any test
    // runs.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo): Promise<void> => {
      const coverageDir = options.server?.coverageDir;
      if (coverageDir === undefined) {
        await use(undefined);
        return;
      }
      if ((workerInfo.parallelIndex ?? 0) !== 0) {
        await use({
          failed:
            'this worker is not the one the server window is collected from — the ' +
            'boot-delta session opens once, against the one server process every ' +
            'worker drives, and a second worker’s tests executing there at the ' +
            'same time would be credited to whichever worker happened to read the ' +
            'next dump. Record with `--workers=1`. Only the recording is serial; the ' +
            'selected runs afterwards are not.',
        });
        return;
      }
      const session = new RemoteBootDeltaSession(
        options.server?.inspectUrl ?? DEFAULT_INSPECT_URL,
        coverageDir,
      );
      let handle: ServerSessionHandle;
      try {
        await session.start();
        handle = { session };
      } catch (err) {
        await session.close();
        handle = { failed: reason(err) };
      }
      await use(handle);
      if (hasSession(handle)) await handle.session.close();
    },
    { scope: 'worker' },
  ];
}

/** Resolve this test's server window, whichever mode produced its session. */
async function resolveServerWindow(
  config: CovselServerWindow,
  legacy: { session: RemoteCoverageSession } | FailedWindow | undefined,
  bootDelta: ServerSessionHandle | undefined,
): Promise<{ window: ObservedWindow | FailedWindow; allowedUnmappable: string[] }> {
  if (config.coverageDir !== undefined) {
    if (bootDelta === undefined) {
      return {
        window: {
          failed: 'the boot-delta server session was not opened for this worker',
        },
        allowedUnmappable: [],
      };
    }
    if (!hasSession(bootDelta)) return { window: bootDelta, allowedUnmappable: [] };
    return closeServerBootDelta(bootDelta.session, config);
  }
  if (legacy === undefined) {
    return {
      window: { failed: 'the server window was not opened for this test' },
      allowedUnmappable: [],
    };
  }
  if ('failed' in legacy) return { window: legacy, allowedUnmappable: [] };
  return closeServer(legacy.session, config);
}

/**
 * The fixtures to hand `test.extend`.
 *
 * Empty unless covsel is driving this run, which it signals by naming the
 * directory the observations go to. That is what keeps a selected run — the
 * common case, and the one whose whole point is to be fast — free of the fixture
 * entirely, rather than paying for a page it would not otherwise have opened.
 */
export function covselFixtures(options: CovselFixturesOptions = {}): CovselFixtures {
  if (options.server !== undefined && options.browser === undefined) {
    // Not a nicety. With two windows the recorder's single declaration cannot
    // stand for either: attached to the browser window it would have a browser
    // recording vouch for the server, and a server change would then read as
    // touching code no test covers.
    throw new Error(
      'covselFixtures({ server }) also needs `browser: { observes: [...] }`. Each ' +
        'window has to say what it alone could see, because the two see different ' +
        'halves of the repository — typically `browser: { observes: ["src/**"] }` ' +
        'beside `server: { observes: ["server/**"] }`. The covsel config\u2019s own ' +
        '`observes` stays the union of them, and recording refuses a window that ' +
        'claims more than it.',
    );
  }
  const outDir = process.env[OUT_DIR_ENV];
  if (outDir === undefined || outDir === '') return {};
  const out = join(outDir, `${process.pid}.jsonl`);
  // Boot-delta mode's session is worker-scoped and needs no per-test opening;
  // legacy mode's is opened fresh inside each test, exactly as before this
  // existed. Which one a given server window uses is decided once here, from
  // configuration, rather than duplicated at every call site below.
  const bootDeltaMode = options.server?.coverageDir !== undefined;

  return {
    covselServerSession: serverSessionFixture(options),
    covselCoverage: [
      async ({ page, covselServerSession }, use, testInfo): Promise<void> => {
        // Counted rather than observed: a page that appears after this test
        // started is one whose first scripts had already run by the time covsel
        // could have attached to it, so what it executed is unknown rather than
        // partially known. Saying so is the only honest answer — a unit missing
        // a page's execution is a test that stops being selected for the code
        // that page ran.
        let appeared = 0;
        page.context().on('page', () => {
          appeared += 1;
        });

        const coverage = page.coverage;
        const usable =
          coverage !== undefined && typeof coverage.startJSCoverage === 'function';
        let started = false;
        if (usable) {
          // `resetOnNavigation: false` because a spec navigates, and coverage
          // reset on each navigation would credit the test with only whatever ran
          // after the last one.
          try {
            await coverage.startJSCoverage({ resetOnNavigation: false });
            started = true;
          } catch {
            /* reported below, once, as the window that produced nothing */
          }
        }

        // Legacy mode only: opened before the test body and taken after it, so
        // what comes back is what this test made the server do. Boot-delta
        // mode's session is already running, from `covselServerSession`.
        const legacyServer =
          options.server === undefined || bootDeltaMode
            ? undefined
            : await openServer(options.server, testInfo);

        try {
          await use();
        } finally {
          const closed = await close(coverage, started, appeared);
          const windows: (ObservedWindow | FailedWindow)[] = [
            scoped(closed.window, options.browser?.observes),
          ];
          const allowedUnmappable = [...closed.allowedUnmappable];
          if (options.server !== undefined) {
            const serverWindow = await resolveServerWindow(
              options.server,
              legacyServer,
              covselServerSession,
            );
            windows.push(serverWindow.window);
            allowedUnmappable.push(...serverWindow.allowedUnmappable);
          }
          const record: ObservedTest = {
            file: repoRelative(testInfo.file),
            name: testInfo.titlePath.join(' '),
            windows,
            allowedUnmappable: [...new Set(allowedUnmappable)],
          };
          appendFileSync(out, `${JSON.stringify(record)}\n`);
        }
      },
      { auto: true },
    ],
  };
}

/**
 * Attach a scope to a window that produced something.
 *
 * Left alone when there is none to attach: the recorder's declaration then
 * stands for the window, which is right exactly when the browser is the only
 * window there is.
 */
function scoped(
  window: ObservedWindow | FailedWindow,
  observes: readonly string[] | undefined,
): ObservedWindow | FailedWindow {
  if ('failed' in window || observes === undefined) return window;
  return { ...window, observes };
}

/** The spec's path as covsel names it, which is relative to the repo root. */
function repoRelative(file: string): string {
  return relative(process.env[CWD_ENV] ?? process.cwd(), file)
    .split('\\')
    .join('/');
}

/**
 * Stop the coverage and turn it into a window, or say why there is none.
 *
 * Every failure here is a *failed* window rather than a thrown error, and the
 * difference matters: thrown, it would fail this one test and leave the rest of
 * the run to record normally, which is a map missing one test's coverage. As a
 * failed window it fails the recording, which is what a hole in the recording is
 * worth.
 */
async function close(
  coverage: CoverageApi | undefined,
  started: boolean,
  appeared: number,
): Promise<{
  window: ObservedWindow | FailedWindow;
  /** Scripts this test's mapping let through unmapped, drained from the mapper. */
  allowedUnmappable: string[];
}> {
  const nothing = (
    failed: string,
  ): { window: FailedWindow; allowedUnmappable: string[] } => ({
    window: { failed },
    allowedUnmappable: [],
  });

  if (coverage === undefined || !started) {
    return nothing(
      'the browser under test reported no JavaScript coverage. covsel records ' +
        'Playwright through Chromium\u2019s coverage API, so record against a ' +
        'Chromium project (`--project=chromium`). The browsers a selection then ' +
        'runs on are not constrained by this \u2014 only the recording is.',
    );
  }

  let entries: Awaited<ReturnType<CoverageApi['stopJSCoverage']>>;
  try {
    entries = await coverage.stopJSCoverage();
  } catch (err) {
    return nothing(
      `the test\u2019s browser coverage could not be collected (${reason(err)}). ` +
        'A page closed by the test takes its coverage with it, so there is no ' +
        'saying what ran in it.',
    );
  }
  if (appeared > 0) {
    return nothing(
      `the test opened ${appeared} further page${appeared === 1 ? '' : 's'} ` +
        '(a popup, or `context.newPage()`), and coverage cannot be attached to one ' +
        'before its first scripts run. What executed there is unknown rather than ' +
        'partly known, so crediting the test with the primary page alone would ' +
        'record it as covering less than it does. covsel observes the primary ' +
        'page only, for now.',
    );
  }

  const { mapper: m, wantBlocks } = mapper();
  const raw = { scripts: entries };
  try {
    const files = await m.toFiles(raw);
    const blocks = wantBlocks ? await m.toBlocks(raw) : [];
    return { window: { files, blocks }, allowedUnmappable: m.takeAllowedUnmappable() };
  } catch (err) {
    // An unmappable script is the expected shape of this failure and already
    // explains itself; anything else is carried through as it came. Either way
    // the scripts already let through are drained, so they do not travel back
    // attached to whichever test maps next.
    return {
      window: {
        failed: err instanceof UnmappableScriptError ? err.message : reason(err),
      },
      allowedUnmappable: m.takeAllowedUnmappable(),
    };
  }
}
