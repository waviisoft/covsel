/**
 * @covsel/adapter-mocha -- per-test selection for Mocha.
 *
 * Mocha already records and selects at file level through the generic
 * NODE_V8_COVERAGE wrap, which needs nothing Mocha-specific: it executes source
 * directly, so the dump names real `file://` paths. This package exists for the
 * one thing the wrap cannot do -- narrowing a run below the file. Recording
 * loads a root hook plugin through Mocha's own `--require` to drive the per-test
 * InspectorObserver, and selection runs the affected spec files under a `--grep`
 * matching the affected tests' full titles. A title pattern only ever matches
 * more tests than intended (two files can hold the same title), so selection
 * stays fail-open.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Adapter,
  type CoveredFile,
  type MapperConfig,
  OBSERVES_EVERYTHING,
  type Recorder,
  type RecordedUnit,
  type RecorderInit,
  type SelectionRunInit,
  type TestId,
  testNamePattern,
  toMapperConfig,
} from '@covsel/core';

const shimPath = fileURLToPath(new URL('./shim.mjs', import.meta.url));

/**
 * Where Mocha's specs live, when the project has not said otherwise.
 *
 * Mocha's own default is the `test` directory with the `js`, `cjs`, and `mjs`
 * extensions, which covsel's `*.test.*` default does not match -- a Mocha
 * project would discover no tests at all zero-config. This is deliberately a
 * superset of what Mocha would run: it descends into subdirectories, which
 * Mocha only does under `--recursive`, and it also matches the `*.test.*` /
 * `*.spec.*` convention wherever those files live. Discovering a file Mocha
 * would not run costs a redundant entry; failing to discover one Mocha would
 * run means that spec sits out every narrowed run, which is the failure covsel
 * exists to prevent.
 */
export const MOCHA_TEST_GLOBS = [
  'test/**/*.{js,cjs,mjs}',
  '**/*.{test,spec}.{js,cjs,mjs}',
];

export const mochaAdapter: Adapter = {
  name: 'mocha',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
  },
  createRecorder(init: RecorderInit): Recorder {
    return createMochaRecorder(init);
  },
  defaultTestGlobs: MOCHA_TEST_GLOBS,
  runSelection(init: SelectionRunInit): number {
    return runMochaSelection(init);
  },
};

/**
 * The export the dynamic resolver reads, so this package is selectable by its
 * specifier exactly as a third-party adapter is.
 */
export const adapter = mochaAdapter;

export interface MochaRecorderInit {
  /** Base command, e.g. `['mocha']`. */
  command: string[];
  cwd: string;
  config: MapperConfig;
  env?: NodeJS.ProcessEnv;
}

interface ShimUnit {
  name: string;
  files: CoveredFile[];
}

/** What the shim writes: the units it observed, and what it let through unmapped. */
interface ShimOutput {
  units: ShimUnit[];
  allowedUnmappable: string[];
}

/**
 * A recorder that runs `mocha --require <shim> <file>` per spec file and reads
 * the per-test coverage the shim wrote, yielding one recorded unit per test.
 *
 * `--no-parallel` is not a preference. Mocha's parallel mode runs the specs --
 * and the root hooks with them -- inside worker processes, while the run's own
 * process is the one that writes the result, so a recording left in parallel
 * mode comes back empty: a map crediting nothing, produced by a run that
 * reported success. Recording one spec file at a time gains nothing from
 * workers anyway, and the flag overrides both a `--parallel` in the project's
 * command and a `parallel` in its Mocha config, so there is no arrangement in
 * which that empty map can be recorded.
 */
export function createMochaRecorder(init: MochaRecorderInit): Recorder {
  const [bin, ...rest] = init.command;
  // Filled by each `record`, drained by `unmappableAllowed` the way the generic
  // recorder drains its mapper: what one spec file let through says nothing
  // about the next.
  let allowedUnmappable: string[] = [];
  return {
    // The shim drives the inspector observer inside the Mocha process, which
    // reports every script that process loads, wherever it lives in the repo.
    observes: OBSERVES_EVERYTHING,
    async record(testFile: string): Promise<RecordedUnit[]> {
      if (bin === undefined) throw new Error('empty command');
      const dir = mkdtempSync(join(tmpdir(), 'covsel-mocha-'));
      const outPath = join(dir, 'out.json');
      try {
        const res = spawnSync(
          bin,
          [...rest, '--no-parallel', '--require', shimPath, testFile],
          {
            cwd: init.cwd,
            env: {
              ...process.env,
              ...init.env,
              COVSEL_TEST_FILE: testFile,
              COVSEL_OUT: outPath,
              // Everything the shim's mapper reads, carried whole: a subset
              // picked by hand is how a project's `sourceMaps` settings stop
              // applying to the adapter that spawns its runner.
              COVSEL_CONFIG: JSON.stringify(toMapperConfig(init.config)),
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        if (res.error) throw res.error;
        if (res.status !== 0) {
          const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
          throw new Error(
            `mocha exited with ${res.status ?? 'signal'} while recording ${testFile}\n${output}`,
          );
        }
        let out: ShimOutput;
        try {
          out = JSON.parse(readFileSync(outPath, 'utf8')) as ShimOutput;
          // Unreadable and readable-but-not-what-the-shim-writes are the same
          // problem to whoever is looking at the message, so they get the same
          // one rather than a TypeError from the mapping below.
          if (!Array.isArray(out.units)) throw new Error('no units');
        } catch {
          throw new Error(`no per-test coverage produced for ${testFile}`);
        }
        allowedUnmappable = out.allowedUnmappable ?? [];
        return out.units.map((u) => ({
          test: { file: testFile, name: u.name },
          files: u.files,
          blocks: [],
        }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    unmappableAllowed(): string[] {
      return allowedUnmappable.splice(0);
    },
  };
}

/** Exactly what the adapter contract hands a runner, named for direct callers. */
export type RunMochaInit = SelectionRunInit;

/**
 * Run only the affected Mocha tests. Spec files that must run in full are
 * invoked plainly; files selected at test level are invoked with a `--grep`
 * built from the affected tests' full titles. Returns the worst exit code seen.
 */
export function runMochaSelection(init: RunMochaInit): number {
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
  // A file already running in full has no use for a name filter, and leaving it
  // in the filtered invocation would run its tests twice.
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
    invoke(['--grep', testNamePattern([...names]), ...namedFiles]);
  }
  return code;
}
