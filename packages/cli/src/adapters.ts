/**
 * The adapters the CLI can dispatch to, in one place. Every per-runner
 * difference the CLI cares about — how to build a recorder, whether the runner
 * can be narrowed below file level, and what to discover as tests when the
 * project has not said — is a field here rather than a branch at each call site.
 */
import type { CovselConfig, Recorder, TestId } from '@covsel/core';
import { createGenericRecorder } from '@covsel/core';
import { createVitestRecorder } from '@covsel/adapter-vitest';
import { createJestRecorder } from '@covsel/adapter-jest';
import { createNodeTestRecorder, runNodeTestSelection } from '@covsel/adapter-node-test';
import {
  createCucumberRecorder,
  CUCUMBER_TEST_GLOBS,
  runCucumberSelection,
} from '@covsel/adapter-cucumber';

export interface RecorderInit {
  command: string[];
  cwd: string;
  config: CovselConfig;
}

export interface SelectionInit {
  selected: TestId[];
  command: string[];
  cwd: string;
}

export interface AdapterEntry {
  createRecorder(init: RecorderInit): Recorder;
  /**
   * Globs to discover tests with when the project has not set `testGlobs`.
   * cucumber's tests are `.feature` files, not the default `*.test.*` sources,
   * so its adapter has to be able to find them zero-config.
   */
  defaultTestGlobs?: string[];
  /**
   * Run a selection through the runner's own filtering. Present only for
   * adapters that record individual tests; without one the CLI hands the runner
   * a file list.
   */
  runSelection?(init: SelectionInit): number;
}

/** Insertion order is the order adapter names are listed back to the user. */
export const ADAPTERS: Record<string, AdapterEntry> = {
  generic: { createRecorder: createGenericRecorder },
  vitest: { createRecorder: createVitestRecorder },
  jest: { createRecorder: createJestRecorder },
  'node-test': {
    createRecorder: createNodeTestRecorder,
    runSelection: runNodeTestSelection,
  },
  cucumber: {
    createRecorder: createCucumberRecorder,
    defaultTestGlobs: [...CUCUMBER_TEST_GLOBS],
    runSelection: runCucumberSelection,
  },
};

export const DEFAULT_ADAPTER = 'generic';

/** The adapter names, rendered for an error message: `'a', 'b', or 'c'`. */
export function adapterNameList(): string {
  const names = Object.keys(ADAPTERS).map((n) => `'${n}'`);
  const last = names.pop();
  return names.length === 0 ? (last ?? '') : `${names.join(', ')}, or ${last}`;
}
