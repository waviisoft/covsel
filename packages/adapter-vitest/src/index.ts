/**
 * @covsel/adapter-vitest -- Vitest support for covsel.
 *
 * Vitest evaluates transformed sources through its own module runner, so raw
 * NODE_V8_COVERAGE at the process boundary never sees the original `src/**`
 * files. Instead this adapter records with Vitest's built-in V8 coverage
 * provider, which remaps execution back to sources through Vite's source maps,
 * and reads the resulting `coverage-final.json`. Selection formatting is a plain
 * file list, exactly like the generic wrap.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Adapter,
  type CovselConfig,
  isPackageInstalled,
  istanbulCoverage,
  OBSERVES_EVERYTHING,
  readIstanbulReport,
  type Recorder,
  type RecordedUnit,
  type RecorderInit,
  type TestId,
  toRepoRelative,
} from '@covsel/core';

export const vitestAdapter: Adapter = {
  name: 'vitest',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
  },
  // covsel reads this runner's report, so covsel decides what it credits.
  coverageReport: 'istanbul',
  createRecorder(init: RecorderInit): Recorder {
    return createVitestRecorder(init);
  },
  listTests(init: RecorderInit): Promise<string[]> {
    return listVitestTests(init);
  },
};

/**
 * Turn the command that *runs* the suite into the one that lists it.
 *
 * `list` is a vitest subcommand rather than a flag, and it replaces `run`
 * instead of joining it -- `vitest run list` reads `list` as a filename filter
 * and runs whatever matches. The first `run` token is therefore substituted,
 * and a command without one gets `list` appended, which covers `vitest`,
 * `vitest run`, `npx vitest run` and the `node_modules/.bin` forms alike.
 *
 * A command that is not a vitest invocation at all -- `pnpm test`, a shell
 * wrapper -- comes out of here as nonsense, and that is what the strict shape
 * check on the output is for. Guessing wrong has to fail loudly: a partial list
 * compares against covsel's discovery as drift, and would send someone editing
 * `testGlobs` over a question the runner was never asked.
 */
function listingCommand(command: readonly string[]): string[] {
  const at = command.indexOf('run');
  const args = [...command];
  if (at === -1) args.push('list');
  else args[at] = 'list';
  // `--filesOnly` because the comparison is against discovered *files*; listing
  // every test name is slower and gives covsel nothing it can use.
  return [...args, '--filesOnly', '--json'];
}

/**
 * The export the dynamic resolver reads, so this package is selectable by its
 * specifier exactly as a third-party adapter is.
 */
export const adapter = vitestAdapter;

export interface VitestRecorderInit {
  /** Base command, e.g. `['vitest', 'run']`. */
  command: string[];
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs' | 'granularity'>;
  env?: NodeJS.ProcessEnv;
}

/** The provider Vitest itself loads to produce V8 coverage. */
const COVERAGE_PROVIDER = '@vitest/coverage-v8';

/**
 * The test files Vitest itself would collect, repo-relative, under the
 * project's own config -- so covsel can compare that against what its
 * `testGlobs` discovered and report where the two disagree.
 */
export async function listVitestTests(init: RecorderInit): Promise<string[]> {
  const [bin, ...rest] = init.command;
  if (bin === undefined) throw new Error('empty command');
  const args = listingCommand(rest);
  const res = spawnSync(bin, args, {
    cwd: init.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const shown = [bin, ...args].join(' ');
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    throw new Error(
      `could not ask vitest what it collects: \`${shown}\` failed\n${output}`,
    );
  }

  // Strictly shaped, and the strictness is the safety property. A command that
  // was never a vitest invocation may still exit 0 having printed something --
  // including vitest's own `--json` *run* report, which is an object rather than
  // this array. Anything that is not a list of `{ file }` is treated as no
  // answer, because a half-understood one compares as drift.
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout ?? '');
  } catch {
    throw new Error(
      `could not ask vitest what it collects: \`${shown}\` printed no JSON. ` +
        'Point `covsel` at vitest directly (e.g. `npx vitest run`) rather than at a ' +
        'script that wraps it, or leave the check out.',
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isListedFile)) {
    throw new Error(
      `could not ask vitest what it collects: \`${shown}\` printed JSON that is not a ` +
        'test file listing. Point `covsel` at vitest directly (e.g. `npx vitest run`) ' +
        'rather than at a script that wraps it, or leave the check out.',
    );
  }

  // A file outside the project is one covsel could never discover either, so
  // reporting it as drift would name something no `testGlobs` edit could fix.
  const files = parsed.map((entry) => toRepoRelative(init.cwd, entry.file));
  return [...new Set(files.filter((rel): rel is string => rel !== undefined))].sort();
}

function isListedFile(entry: unknown): entry is { file: string } {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { file?: unknown }).file === 'string'
  );
}

/**
 * A recorder that runs `<command> <testFile>` once with Vitest's V8 coverage
 * enabled and attributes the JSON report to that test file. Requires
 * `@vitest/coverage-v8` to be installed in the target project.
 */
export function createVitestRecorder(init: VitestRecorderInit): Recorder {
  // Checked before anything runs. Without the provider, Vitest executes the
  // suite quite happily and simply writes no report, so the problem otherwise
  // surfaces once per test file *after* the whole suite has been paid for --
  // and what it needs is one install, which is worth saying up front.
  if (!isPackageInstalled(init.cwd, COVERAGE_PROVIDER)) {
    throw new Error(
      `${COVERAGE_PROVIDER} is not installed, and the Vitest adapter records through ` +
        `Vitest's own coverage provider. Install it with ` +
        `\`npm install --save-dev ${COVERAGE_PROVIDER}\`, or run \`covsel init\`, ` +
        `which installs it alongside the adapter.`,
    );
  }
  return {
    // Vitest's V8 provider reports every module its runner loaded, remapped to
    // the original file, so any source under the repo that a test reaches shows
    // up in the report regardless of where it lives.
    observes: OBSERVES_EVERYTHING,
    async record(testFile: string): Promise<RecordedUnit[]> {
      const reportsDir = mkdtempSync(join(tmpdir(), 'covsel-vitest-'));
      const [bin, ...rest] = init.command;
      if (bin === undefined) throw new Error('empty command');
      try {
        const res = spawnSync(
          bin,
          [
            ...rest,
            testFile,
            '--coverage.enabled',
            '--coverage.provider=v8',
            '--coverage.reporter=json',
            `--coverage.reportsDirectory=${reportsDir}`,
            '--coverage.all=false',
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
            `vitest exited with ${res.status ?? 'signal'} while recording ${testFile}\n${output}`,
          );
        }

        // core owns what a report means; the adapter owns what a missing one
        // means, which here is the coverage provider Vitest needs and does not
        // bundle.
        const report = readIstanbulReport(join(reportsDir, 'coverage-final.json'));
        if (report === undefined) {
          throw new Error(
            `no coverage report produced for ${testFile} -- is @vitest/coverage-v8 installed?`,
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
