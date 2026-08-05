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

import { type MapperConfig, UnmappableScriptError, V8FileMapper } from '@covsel/core';

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
}

/** The auto-fixture, in the tuple form `test.extend` takes. */
export type CovselFixture = [
  (
    args: { page: PageLike },
    use: (value: void) => Promise<void>,
    testInfo: TestInfoLike,
  ) => Promise<void>,
  { auto: true },
];

/** What `covselFixtures()` returns: the fixture, or nothing outside a recording. */
export interface CovselFixtures {
  covselCoverage?: CovselFixture;
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
 * The fixtures to hand `test.extend`.
 *
 * Empty unless covsel is driving this run, which it signals by naming the
 * directory the observations go to. That is what keeps a selected run — the
 * common case, and the one whose whole point is to be fast — free of the fixture
 * entirely, rather than paying for a page it would not otherwise have opened.
 */
export function covselFixtures(): CovselFixtures {
  const outDir = process.env[OUT_DIR_ENV];
  if (outDir === undefined || outDir === '') return {};
  const out = join(outDir, `${process.pid}.jsonl`);

  return {
    covselCoverage: [
      async ({ page }, use, testInfo): Promise<void> => {
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

        try {
          await use();
        } finally {
          const closed = await close(coverage, started, appeared);
          const record: ObservedTest = {
            file: repoRelative(testInfo.file),
            name: testInfo.titlePath.join(' '),
            windows: [closed.window],
            allowedUnmappable: closed.allowedUnmappable,
          };
          appendFileSync(out, `${JSON.stringify(record)}\n`);
        }
      },
      { auto: true },
    ],
  };
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
