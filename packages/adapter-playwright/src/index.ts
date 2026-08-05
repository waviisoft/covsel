/**
 * @covsel/adapter-playwright -- per-test selection for Playwright.
 *
 * A Playwright test executes code in three places: the worker running the spec,
 * the browser showing the application, and usually a server behind it. This
 * adapter observes the **browser**, because that is where the code a UI test is
 * really about runs, and because nothing covsel had before could see it at all.
 *
 * It observes nothing else, and says so. The scope the project declares in
 * `observes` is what the map is stamped with, so every change outside it -- a
 * server route, a build script, anything the browser never loaded -- falls open
 * to a full run rather than being read as code no test covers. That is the whole
 * bargain of a partial adapter: real selection on the client, and no opinion
 * whatsoever about the rest.
 *
 * Recording is one `playwright test` invocation, so the `webServer` boots once,
 * and an auto-fixture in each worker attributes the browser's coverage to the
 * test that caused it. Selection hands Playwright back the affected spec files
 * narrowed by `--grep`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Adapter,
  combineObservations,
  type CovselConfig,
  type MapperConfig,
  type ObservationWindow,
  type Recorder,
  type RecordedUnit,
  type RecorderInit,
  type SelectionRunInit,
  testNameSuffixPattern,
  type TestId,
  toMapperConfig,
} from '@covsel/core';

import {
  BLOCKS_ENV,
  CONFIG_ENV,
  CWD_ENV,
  type ObservedTest,
  OUT_DIR_ENV,
} from './protocol.js';

export type {
  ContextLike,
  CoverageApi,
  CovselFixture,
  CovselFixtures,
  PageLike,
  TestInfoLike,
} from './fixture.js';
export { covselFixtures } from './fixture.js';
export type { ObservedTest, ObservedWindow, FailedWindow } from './protocol.js';

/** Playwright's own default `testMatch`, so specs are discovered zero-config. */
export const PLAYWRIGHT_TEST_GLOBS = ['**/*.@(spec|test).?(c|m)[jt]s?(x)'];

export const playwrightAdapter: Adapter = {
  name: 'playwright',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
  },
  createRecorder(init: RecorderInit): Recorder {
    return createPlaywrightRecorder(init);
  },
  defaultTestGlobs: PLAYWRIGHT_TEST_GLOBS,
  runSelection(init: SelectionRunInit): number {
    return runPlaywrightSelection(init);
  },
};

/**
 * The export the dynamic resolver reads, so this package is selectable by its
 * specifier exactly as a third-party adapter is.
 */
export const adapter = playwrightAdapter;

export interface PlaywrightRecorderInit {
  /** Base command, e.g. `['playwright', 'test']`. */
  command: string[];
  cwd: string;
  config: MapperConfig & Pick<CovselConfig, 'granularity' | 'observes'>;
  env?: NodeJS.ProcessEnv;
}

/**
 * What to tell a project that has not said what its browser can see.
 *
 * There is no default that is not a lie. `**` claims the recording watched the
 * server, the build scripts, and the CLI, none of which a browser loads -- and a
 * change to any of them would then be read as touching code no test covers, and
 * skip every test. Nothing at all claims the opposite, and turns every recording
 * into a map that falls open on everything, which is a full run dressed up as
 * selection. Only the project knows which of its paths reach the browser.
 */
const NO_SCOPE =
  'covsel cannot record Playwright until this project says what its browser ' +
  'coverage is able to see. Set `observes` in the covsel config to the globs ' +
  'whose code the browser executes -- typically the client sources a build ' +
  'ships, e.g. `"observes": ["src/**"]`. Everything outside it falls open: a ' +
  'change there runs the whole suite, because this recording cannot speak for ' +
  'it. Declare a path only when code there running would have been seen -- a ' +
  'glob claiming more than the browser loads is how a test stops being selected ' +
  'for a change that breaks it.';

/**
 * A recorder that runs the whole suite once, with the fixture writing what each
 * test executed in the browser, and returns one unit per test.
 *
 * Whole-run rather than file-by-file because a Playwright invocation pays for a
 * browser launch and usually an application boot; driven once per spec file, a
 * recording of any real suite is one nobody runs twice. Recording reconciles the
 * units against the files it asked about, so a spec the run never mentions fails
 * the recording rather than being written down as covering nothing.
 */
export function createPlaywrightRecorder(init: PlaywrightRecorderInit): Recorder {
  const [bin, ...rest] = init.command;
  const observes = init.config.observes ?? [];
  // Checked when the recorder is built rather than when the run finishes, so a
  // project missing the declaration hears about it before it has paid for a
  // whole suite.
  if (observes.length === 0) throw new Error(NO_SCOPE);
  // Drained by `unmappableAllowed`, exactly as the per-file recorders drain
  // theirs. One invocation covered the suite, so this is what the *run* let
  // through unmapped.
  let allowedUnmappable: string[] = [];

  return {
    // Only the browser, and only the paths the project stands behind. This is
    // the ceiling recording holds every unit to.
    observes,
    async recordRun(testFiles: readonly string[]): Promise<RecordedUnit[]> {
      if (bin === undefined) throw new Error('empty command');
      const dir = mkdtempSync(join(tmpdir(), 'covsel-playwright-'));
      try {
        const res = spawnSync(bin, [...rest, ...testFiles], {
          cwd: init.cwd,
          env: {
            ...process.env,
            ...init.env,
            [OUT_DIR_ENV]: dir,
            [CWD_ENV]: init.cwd,
            [BLOCKS_ENV]: init.config.granularity === 'file' ? '0' : '1',
            // Everything the fixture's mapper reads, carried whole: a subset
            // picked by hand is how a project's `sourceMaps` settings stop
            // applying to the adapter that spawns its runner.
            [CONFIG_ENV]: JSON.stringify(toMapperConfig(init.config)),
          },
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        if (res.error) throw res.error;
        if (res.status !== 0) {
          const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
          throw new Error(
            `playwright exited with ${res.status ?? 'signal'} while recording the ` +
              `run. A suite that did not pass cannot be recorded: a test that failed ` +
              `partway executed part of what it covers.\n${output}`,
          );
        }
        const observed = readObservations(dir);
        if (observed.length === 0) {
          throw new Error(
            'the run produced no per-test coverage. covsel records Playwright ' +
              'through an auto-fixture the project installs on its own `test` ' +
              'object -- add `export const test = base.extend(covselFixtures())` ' +
              "from '@covsel/adapter-playwright/fixture' and import your specs' " +
              '`test` from there.',
          );
        }
        allowedUnmappable = [
          ...new Set(observed.flatMap((o) => o.allowedUnmappable ?? [])),
        ];
        // One unit per record, so a test Playwright retried contributes one per
        // attempt. Those are separate executions of the same test rather than
        // separate views of one, so they stay separate entries and selection
        // matches whichever of them a diff touches — which credits the test with
        // everything any attempt ran. Folding them into one window would be the
        // other reading, and the wrong one: an attempt that died early recorded
        // no blocks for the files it partly covered, and combining would take
        // that as knowledge about them.
        return observed.map((o) =>
          // Combined even though Phase 1 opens a single window per test: it is
          // what turns a window that produced nothing into a failed recording
          // rather than a unit that silently covers less, and it is where the
          // server window joins when there is one.
          combineObservations({ file: o.file, name: o.name }, windowsOf(o, observes)),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    unmappableAllowed(): string[] {
      return allowedUnmappable.splice(0);
    },
  };
}

/** Attach the recorder's scope to each window the fixture reported. */
function windowsOf(
  observed: ObservedTest,
  observes: readonly string[],
): ObservationWindow[] {
  return (observed.windows ?? []).map((w) =>
    'failed' in w ? w : { files: w.files, blocks: w.blocks, observes },
  );
}

/**
 * Everything the run's workers wrote.
 *
 * One file per worker, appended a line at a time as each test finishes, because
 * Playwright runs several workers at once and a worker that dies takes whatever
 * it was holding with it. A line that will not parse is dropped rather than
 * failing the read: it is a partial write from a worker killed mid-line, and the
 * test behind it is then a test the run never reported -- which recording
 * already refuses, by name, against the files it asked about.
 */
function readObservations(dir: string): ObservedTest[] {
  const out: ObservedTest[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let parsed: ObservedTest;
      try {
        parsed = JSON.parse(line) as ObservedTest;
      } catch {
        continue;
      }
      if (typeof parsed.file === 'string' && typeof parsed.name === 'string') {
        out.push(parsed);
      }
    }
  }
  return out;
}

/** Exactly what the adapter contract hands a runner, named for direct callers. */
export type RunPlaywrightInit = SelectionRunInit;

/**
 * Run only the affected tests. Spec files that must run in full are invoked
 * plainly; files selected per test are invoked with a `--grep` pattern built
 * from the affected titles. Returns the worst exit code.
 *
 * The pattern is anchored at its end only, because Playwright matches it against
 * a title it has prefixed with the project name -- and a pattern naming one
 * browser would run a map recorded on Chromium against Chromium alone, skipping
 * every Firefox and WebKit test the diff affected.
 */
export function runPlaywrightSelection(init: RunPlaywrightInit): number {
  const [bin, ...rest] = init.command;
  if (bin === undefined) throw new Error('empty command');

  const wholeFiles = new Set<string>();
  const namedFiles = new Set<string>();
  const names = new Set<string>();
  for (const unit of init.selected) {
    if (unit.name === undefined) wholeFiles.add(unit.file);
    else {
      namedFiles.add(unit.file);
      names.add(unit.name);
    }
  }
  for (const file of wholeFiles) namedFiles.delete(file);

  const stdio = init.stdio ?? 'inherit';
  let code = 0;
  const invoke = (extra: string[]): void => {
    const res = spawnSync(bin, [...rest, ...extra], { cwd: init.cwd, stdio });
    if (res.error) throw res.error;
    if ((res.status ?? 1) !== 0) code = res.status ?? 1;
  };

  if (wholeFiles.size > 0) invoke([...wholeFiles]);
  if (namedFiles.size > 0) {
    invoke([...namedFiles, '--grep', testNameSuffixPattern([...names])]);
  }
  return code;
}
