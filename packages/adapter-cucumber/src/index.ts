/**
 * @covsel/adapter-cucumber — scenario-level selection for cucumber-js.
 *
 * cucumber-js has no built-in test selection, so this is the case covsel exists
 * for: record what each *scenario* executes, then run only the scenarios a diff
 * can affect. Recording preloads a support-code shim through cucumber's own
 * `--import`; selection runs the affected feature files filtered by `--name`.
 * A name pattern only ever matches more scenarios than intended (duplicate names,
 * scenario outlines), so selection stays fail-open.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Adapter,
  CoveredFile,
  CovselConfig,
  Recorder,
  RecordedUnit,
  TestId,
} from '@covsel/core';

const shimPath = fileURLToPath(new URL('./shim.js', import.meta.url));

/** Feature files are the unit every cucumber project has; scenarios live inside them. */
export const CUCUMBER_TEST_GLOBS = ['**/*.feature'];

export const cucumberAdapter: Adapter = {
  name: 'cucumber',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
  },
};

export interface CucumberRecorderInit {
  /** Base command, e.g. `['cucumber-js']`. */
  command: string[];
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs'>;
  env?: NodeJS.ProcessEnv;
}

interface ShimUnit {
  file: string;
  name: string;
  files: CoveredFile[];
}

/**
 * Cucumber's `--import` replaces its default support-code discovery, so the
 * shim alone would leave the project's step definitions unloaded. Re-supplying
 * the conventional glob for the feature's own directory restores that default;
 * importing the same file twice is harmless, and a project that declares
 * `import` in its cucumber config keeps working because the CLI flag and the
 * config are merged.
 */
function supportGlobFor(featureFile: string): string {
  const dir = featureFile.split('/')[0] ?? 'features';
  return `${dir}/**/*.{js,cjs,mjs}`;
}

/**
 * A recorder that runs the suite one feature file at a time with the shim
 * loaded, yielding one recorded unit per scenario.
 */
export function createCucumberRecorder(init: CucumberRecorderInit): Recorder {
  const [bin, ...rest] = init.command;
  return {
    async record(featureFile: string): Promise<RecordedUnit[]> {
      if (bin === undefined) throw new Error('empty command');
      const dir = mkdtempSync(join(tmpdir(), 'covsel-cucumber-'));
      const outPath = join(dir, 'out.json');
      try {
        const res = spawnSync(
          bin,
          [
            ...rest,
            featureFile,
            '--import',
            supportGlobFor(featureFile),
            '--import',
            shimPath,
          ],
          {
            cwd: init.cwd,
            env: {
              ...process.env,
              ...init.env,
              COVSEL_OUT: outPath,
              COVSEL_CONFIG: JSON.stringify({
                sourceGlobs: init.config.sourceGlobs,
                testGlobs: init.config.testGlobs,
              }),
            },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        if (res.error) throw res.error;
        if (res.status !== 0) {
          const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
          throw new Error(
            `cucumber-js exited with ${res.status ?? 'signal'} while recording ${featureFile}\n${output}`,
          );
        }
        let units: ShimUnit[];
        try {
          units = JSON.parse(readFileSync(outPath, 'utf8')) as ShimUnit[];
        } catch {
          throw new Error(`no per-scenario coverage produced for ${featureFile}`);
        }
        return units.map((u) => ({
          test: { file: featureFile, name: u.name },
          files: u.files,
          blocks: [],
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

export interface RunCucumberInit {
  /** The selected units from `selectAffected`. */
  selected: TestId[];
  /** Base command, e.g. `['cucumber-js']`. */
  command: string[];
  cwd: string;
  /** Child stdio (default `'inherit'` so the user sees the runner output). */
  stdio?: 'inherit' | 'ignore';
}

/**
 * Run only the affected scenarios. Feature files that must run in full are
 * invoked plainly; files selected at scenario level are invoked with a `--name`
 * pattern built from the affected scenario names. Returns the worst exit code.
 */
export function runCucumberSelection(init: RunCucumberInit): number {
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
    invoke([...namedFiles, '--name', namePattern([...names])]);
  }
  return code;
}
