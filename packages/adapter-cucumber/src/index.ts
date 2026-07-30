/**
 * @covsel/adapter-cucumber -- scenario-level selection for cucumber-js.
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
  toMapperConfig,
} from '@covsel/core';

const shimPath = fileURLToPath(new URL('./shim.js', import.meta.url));

/** Feature files are the unit every cucumber project has; scenarios live inside them. */
export const CUCUMBER_TEST_GLOBS = ['**/*.feature'];

export const cucumberAdapter: Adapter = {
  name: 'cucumber',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
  },
  createRecorder(init: RecorderInit): Recorder {
    return createCucumberRecorder(init);
  },
  defaultTestGlobs: CUCUMBER_TEST_GLOBS,
  runSelection(init: SelectionRunInit): number {
    return runCucumberSelection(init);
  },
};

/**
 * The export the dynamic resolver reads, so this package is selectable by its
 * specifier exactly as a third-party adapter is.
 */
export const adapter = cucumberAdapter;

export interface CucumberRecorderInit {
  /** Base command, e.g. `['cucumber-js']`. */
  command: string[];
  cwd: string;
  config: MapperConfig;
  env?: NodeJS.ProcessEnv;
}

interface ShimUnit {
  file: string;
  name: string;
  files: CoveredFile[];
}

/** What the shim writes: the units it observed, and what it let through unmapped. */
interface ShimOutput {
  units: ShimUnit[];
  allowedUnmappable: string[];
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
  // Filled by each `record`, drained by `unmappableAllowed` the way the generic
  // recorder drains its mapper: what one feature file let through says nothing
  // about the next.
  let allowedUnmappable: string[] = [];
  return {
    // The shim drives the inspector observer inside the cucumber process, which
    // reports every script that process loads, wherever it lives in the repo.
    observes: OBSERVES_EVERYTHING,
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
            `cucumber-js exited with ${res.status ?? 'signal'} while recording ${featureFile}\n${output}`,
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
          throw new Error(`no per-scenario coverage produced for ${featureFile}`);
        }
        allowedUnmappable = out.allowedUnmappable ?? [];
        return out.units.map((u) => ({
          test: { file: featureFile, name: u.name },
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

function namePattern(names: string[]): string {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^(?:${escaped.join('|')})$`;
}

/** Exactly what the adapter contract hands a runner, named for direct callers. */
export type RunCucumberInit = SelectionRunInit;

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
