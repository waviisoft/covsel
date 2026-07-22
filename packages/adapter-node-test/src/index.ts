/**
 * @covsel/adapter-node-test — per-test selection for Node's built-in test runner.
 *
 * Records each test's coverage individually by preloading a shim that drives the
 * per-test InspectorObserver, and runs only the affected tests via node:test's
 * `--test-name-pattern`. A pattern built from a test's leaf name runs that test
 * even inside a non-matching `describe`, and duplicate leaf names only ever
 * over-run — so selection stays fail-open.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  Adapter,
  CoveredBlock,
  CoveredFile,
  CovselConfig,
  Recorder,
  RecordedUnit,
  TestId,
} from '@covsel/core';

const shimUrl = pathToFileURL(fileURLToPath(new URL('./shim.js', import.meta.url))).href;

export const nodeTestAdapter: Adapter = {
  name: 'node-test',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
  },
};

export interface NodeTestRecorderInit {
  /** Base command, e.g. `['node', '--test']`. */
  command: string[];
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs' | 'granularity'>;
  env?: NodeJS.ProcessEnv;
}

interface ShimUnit {
  name: string;
  files: CoveredFile[];
  blocks?: CoveredBlock[];
}

/**
 * A recorder that runs `node --import <shim> --test <file>` per test file and
 * reads the per-test coverage the shim wrote, yielding one recorded unit per
 * individual test.
 */
export function createNodeTestRecorder(init: NodeTestRecorderInit): Recorder {
  const [bin, ...rest] = init.command;
  return {
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
            COVSEL_CONFIG: JSON.stringify({
              sourceGlobs: init.config.sourceGlobs,
              testGlobs: init.config.testGlobs,
              granularity: init.config.granularity,
            }),
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
        let units: ShimUnit[];
        try {
          units = JSON.parse(readFileSync(outPath, 'utf8')) as ShimUnit[];
        } catch {
          throw new Error(`no per-test coverage produced for ${testFile}`);
        }
        return units.map((u) => ({
          test: { file: testFile, name: u.name },
          files: u.files,
          blocks: u.blocks ?? [],
        }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function namePattern(names: string[]): string {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^(?:${escaped.join('|')})$`;
}

export interface RunNodeTestInit {
  /** The selected test units from `selectAffected`. */
  selected: TestId[];
  /** Base command, e.g. `['node', '--test']`. */
  command: string[];
  cwd: string;
  /** Child stdio (default `'inherit'` so the user sees the runner output). */
  stdio?: 'inherit' | 'ignore';
}

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
    invoke([`--test-name-pattern=${namePattern([...names])}`, ...namedFiles]);
  }
  return code;
}
