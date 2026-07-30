/**
 * @covsel/adapter-node-test -- per-test selection for Node's built-in test runner.
 *
 * Records each test's coverage individually by preloading a shim that drives the
 * per-test InspectorObserver, and runs only the affected tests via node:test's
 * `--test-name-pattern`. A pattern built from a test's leaf name runs that test
 * even inside a non-matching `describe`, and duplicate leaf names only ever
 * over-run -- so selection stays fail-open.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  type Adapter,
  type CoveredBlock,
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

const shimUrl = pathToFileURL(fileURLToPath(new URL('./shim.js', import.meta.url))).href;

export const nodeTestAdapter: Adapter = {
  name: 'node-test',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
  },
  createRecorder(init: RecorderInit): Recorder {
    return createNodeTestRecorder(init);
  },
  runSelection(init: SelectionRunInit): number {
    return runNodeTestSelection(init);
  },
};

/**
 * The export the dynamic resolver reads, so this package is selectable by its
 * specifier exactly as a third-party adapter is.
 */
export const adapter = nodeTestAdapter;

export interface NodeTestRecorderInit {
  /** Base command, e.g. `['node', '--test']`. */
  command: string[];
  cwd: string;
  config: MapperConfig;
  env?: NodeJS.ProcessEnv;
}

interface ShimUnit {
  name: string;
  files: CoveredFile[];
  blocks?: CoveredBlock[];
}

/** What the shim writes: the units it observed, and what it let through unmapped. */
interface ShimOutput {
  units: ShimUnit[];
  allowedUnmappable: string[];
}

/**
 * A recorder that runs `node --import <shim> --test <file>` per test file and
 * reads the per-test coverage the shim wrote, yielding one recorded unit per
 * individual test.
 */
export function createNodeTestRecorder(init: NodeTestRecorderInit): Recorder {
  const [bin, ...rest] = init.command;
  // Filled by each `record`, drained by `unmappableAllowed` the way the generic
  // recorder drains its mapper: what one file let through says nothing about
  // the next.
  let allowedUnmappable: string[] = [];
  return {
    // The inspector observer watches the isolate the tests run in and reports
    // every script it loads, so any repo path a test executes is visible.
    observes: OBSERVES_EVERYTHING,
    async record(testFile: string): Promise<RecordedUnit[]> {
      if (bin === undefined) throw new Error('empty command');
      const dir = mkdtempSync(join(tmpdir(), 'covsel-nodetest-'));
      const outPath = join(dir, 'out.json');
      try {
        const res = spawnSync(bin, ['--import', shimUrl, ...rest, testFile], {
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
        });
        if (res.error) throw res.error;
        if (res.status !== 0) {
          const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
          throw new Error(
            `node --test exited with ${res.status ?? 'signal'} while recording ${testFile}\n${output}`,
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
          blocks: u.blocks ?? [],
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
export type RunNodeTestInit = SelectionRunInit;

/**
 * Run only the affected node:test tests. Files that must run in full are invoked
 * plainly; files selected at test level are invoked with a `--test-name-pattern`
 * built from the affected test names. Returns the worst exit code seen.
 */
export function runNodeTestSelection(init: RunNodeTestInit): number {
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

  const stdio = init.stdio ?? 'inherit';
  let code = 0;
  const invoke = (extra: string[]): void => {
    const res = spawnSync(bin, [...rest, ...extra], { cwd: init.cwd, stdio });
    if (res.error) throw res.error;
    if ((res.status ?? 1) !== 0) code = res.status ?? 1;
  };

  // node:test only honors --test-name-pattern when it precedes the file args.
  if (wholeFiles.size > 0) invoke([...wholeFiles]);
  if (namedFiles.size > 0) {
    invoke([`--test-name-pattern=${testNamePattern([...names])}`, ...namedFiles]);
  }
  return code;
}
