/**
 * @covsel/adapter-jest -- Jest support for covsel.
 *
 * Jest evaluates code through its own transformer and module registry, so raw
 * NODE_V8_COVERAGE at the process boundary cannot be trusted for Jest. The dump
 * does name the original files, which makes it look usable, but the offsets in
 * it address the *transformed* module source: a function in a small source file
 * is reported at ranges past that file's end, and any block hashed from those
 * ranges is meaningless. Instead this adapter records with Jest's own coverage,
 * which remaps execution back to sources through the transformer's source maps,
 * and reads the resulting istanbul-shaped `coverage-final.json`. Selection
 * formatting is a plain file list, exactly like the generic wrap.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Adapter,
  type CovselConfig,
  istanbulCoverage,
  OBSERVES_EVERYTHING,
  readIstanbulReport,
  type Recorder,
  type RecordedUnit,
  type RecorderInit,
  type TestId,
} from '@covsel/core';

export const jestAdapter: Adapter = {
  name: 'jest',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
  },
  // covsel reads this runner's report, so covsel decides what it credits.
  coverageReport: 'istanbul',
  createRecorder(init: RecorderInit): Recorder {
    return createJestRecorder(init);
  },
};

/**
 * The export the dynamic resolver reads, so this package is selectable by its
 * specifier exactly as a third-party adapter is.
 */
export const adapter = jestAdapter;

export interface JestRecorderInit {
  /** Base command, e.g. `['jest']`. */
  command: string[];
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs' | 'granularity'>;
  env?: NodeJS.ProcessEnv;
}

/**
 * A recorder that runs `<command> <testFile>` once with Jest's coverage enabled
 * and attributes the JSON report to that test file. Coverage is built into Jest,
 * so no extra dependency is needed in the target project.
 */
export function createJestRecorder(init: JestRecorderInit): Recorder {
  return {
    // Jest's coverage reports every module its registry loaded, remapped to the
    // original file, so any source under the repo that a test reaches shows up
    // in the report regardless of where it lives.
    observes: OBSERVES_EVERYTHING,
    async record(testFile: string): Promise<RecordedUnit[]> {
      const reportsDir = mkdtempSync(join(tmpdir(), 'covsel-jest-'));
      const [bin, ...rest] = init.command;
      if (bin === undefined) throw new Error('empty command');
      try {
        const res = spawnSync(
          bin,
          [
            ...rest,
            '--coverage',
            '--coverageReporters=json',
            `--coverageDirectory=${reportsDir}`,
            // Recording observes one test file at a time, which trips any
            // coverage threshold the project configured for a whole run.
            // Observation is not a quality gate, so neutralize them.
            '--coverageThreshold={}',
            // Bare positional arguments are regexes matched against every test
            // path, so a path can pull in files it merely resembles and
            // contaminate this file's entry. This makes the match exact.
            '--runTestsByPath',
            testFile,
          ],
          {
            cwd: init.cwd,
            env: { ...process.env, ...init.env },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        if (res.error) throw res.error;
        if (res.status !== 0) {
          const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
          throw new Error(
            `jest exited with ${res.status ?? 'signal'} while recording ${testFile}\n${output}`,
          );
        }

        // core owns what a report means; the adapter owns what a missing one
        // means, which for Jest -- whose coverage is built in -- points at the
        // project's own reporter or directory configuration rather than at a
        // missing dependency.
        const report = readIstanbulReport(join(reportsDir, 'coverage-final.json'));
        if (report === undefined) {
          throw new Error(
            `no coverage report produced for ${testFile} -- does the jest config ` +
              `override coverageReporters or coverageDirectory?`,
          );
        }
        const { files, blocks } = istanbulCoverage(report, {
          cwd: init.cwd,
          config: init.config,
        });
        return [{ test: { file: testFile }, files, blocks }];
      } finally {
        rmSync(reportsDir, { recursive: true, force: true });
      }
    },
  };
}
