/**
 * @covsel/adapter-harness -- a test harness in any language, driving a Node
 * application from outside (HTTP, a browser, an MCP client...), recorded from
 * the application server's own inspector.
 *
 * The test process is never Node, so neither the generic wrap
 * (`NODE_V8_COVERAGE` on the process covsel spawns) nor a per-runner adapter
 * observes anything useful -- all the application code runs in the **server**,
 * a process this adapter never starts and never touches beyond connecting to
 * the inspector it opts into with `--inspect`. Two ways to find test
 * boundaries, both supported:
 *
 *  - **One invocation per test** (`harness.boundary` unset): the harness needs
 *    nothing from covsel. Slower, because every test pays the harness's own
 *    start-up cost.
 *  - **The boundary protocol, one invocation** (`harness.boundary` set): a
 *    cooperating harness announces each test's start and end over HTTP (see
 *    `protocol.ts`), so the full run CI already does can also be the
 *    recording.
 *
 * Selection hands the harness back its own native flag, built from the
 * project's own `harness.run` template -- covsel does not guess it.
 */
import { spawnSync } from 'node:child_process';

import {
  type Adapter,
  type CovselConfig,
  type Recorder,
  type RecorderInit,
  type SelectionRunInit,
  type TestId,
} from '@covsel/core';

import { createBoundaryRecorder } from './boundary-server.js';
import { type HarnessConfig, resolveHarnessConfig } from './config.js';
import { createPerTestRecorder } from './per-test-recorder.js';

export type {
  HarnessBoundaryConfig,
  HarnessConfig,
  HarnessServerConfig,
} from './config.js';
export {
  BOUNDARY_ENV,
  type BeginMessage,
  type EndMessage,
  type Outcome,
  OUTCOMES,
} from './protocol.js';
export type { RunTemplate } from './run-template.js';

function harnessConfigOf(config: CovselConfig | undefined): HarnessConfig {
  return resolveHarnessConfig(config?.harness);
}

export const harnessAdapter: Adapter = {
  name: 'harness',
  formatSelection(tests: TestId[]): string[] {
    // A plain, readable list of the ids selected -- what `covsel affected`
    // prints and what a caller sharding the suite reads. The actual runner
    // invocation is built by `runSelection`, from the project's own
    // `harness.run` template, because there is no fixed flag to append a file
    // list to the way there is for a runner with a native file argument.
    return [...new Set(tests.map((t) => t.file))];
  },
  createRecorder(init: RecorderInit): Recorder {
    const harness = harnessConfigOf(init.config);
    const shared = {
      command: init.command,
      cwd: init.cwd,
      config: init.config,
      harness,
    };
    return harness.boundary !== undefined
      ? createBoundaryRecorder(shared)
      : createPerTestRecorder(shared);
  },
  runSelection(init: SelectionRunInit): number {
    const [bin, ...rest] = init.command;
    if (bin === undefined) throw new Error('empty command');
    const harness = harnessConfigOf(init.config);
    const ids = [...new Set(init.selected.map((t) => t.file))];
    // Core already refuses to call this with an empty selection -- appending
    // no ids here would run the bare command, which is a full run mistaken for
    // "nothing affected". Kept as a second guard because this function has to
    // stand on its own: nothing stops a future caller from reaching it directly.
    if (ids.length === 0) return 0;
    const args = harness.run.expand(ids);
    const stdio = init.stdio ?? 'inherit';
    const res =
      stdio === 'inherit'
        ? spawnSync(bin, [...rest, ...args], { cwd: init.cwd, stdio: 'inherit' })
        : spawnSync(bin, [...rest, ...args], { cwd: init.cwd, stdio: 'ignore' });
    if (res.error) throw res.error;
    return res.status ?? 1;
  },
};

/**
 * The export the dynamic resolver reads, so this package is selectable by its
 * specifier exactly as a third-party adapter is.
 */
export const adapter = harnessAdapter;
