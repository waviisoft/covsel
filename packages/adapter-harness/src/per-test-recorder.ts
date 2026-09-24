/**
 * Recording mode (a): one harness invocation per test.
 *
 * No cooperation needed from the harness at all — it is simply run once per
 * test id, exactly as `harness.run` says a selected run would invoke it for
 * that one id. The cost is a harness start-up per test; the benefit is that
 * this works for a harness nobody has touched.
 *
 * The application server has to already be running, with its inspector open,
 * before recording starts, and has to keep running across every invocation:
 * this recorder only ever connects to it, exactly as the Playwright adapter's
 * server window does, and never starts or stops it.
 */
import {
  type CovselConfig,
  type MapperConfig,
  type Recorder,
  type RecordedUnit,
  RemoteCoverageSession,
  V8FileMapper,
} from '@covsel/core';

import { DEFAULT_TEST_TIMEOUT_MS, type HarnessConfig } from './config.js';
import { spawnDetached } from './spawn-detached.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PerTestRecorderInit {
  /** Base command, e.g. `['python3', 'harness/run.py', '--format', 'json']`. */
  command: string[];
  cwd: string;
  config: MapperConfig & Pick<CovselConfig, 'granularity'>;
  harness: HarnessConfig;
}

export function createPerTestRecorder(init: PerTestRecorderInit): Recorder {
  const [bin, ...rest] = init.command;
  const { server, run } = init.harness;
  const wantBlocks = init.config.granularity !== 'file';
  const mapper = new V8FileMapper({ cwd: init.cwd, config: init.config });
  const testTimeoutMs = init.harness.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const settleMs = server.settleMs;

  return {
    observes: server.observes,
    // Every id is already an opaque string handed straight to `harness.run`,
    // never a path this process reads -- exactly what lets covsel record a
    // scenario that is not a file in this repository at all, when one is
    // named only by a configured `inventory`.
    recordsInventoryIds: true,
    async record(testFile: string): Promise<RecordedUnit[]> {
      if (bin === undefined) throw new Error('empty command');
      const session = new RemoteCoverageSession(server.inspectUrl);
      await session.start();

      const args = run.expand([testFile]);
      // Spawned detached, in its own process group, exactly the way the
      // boundary protocol's own harness invocation is -- a bare `spawnSync`
      // `timeout` only signals the direct child, never anything it forks, so
      // a harness that is itself a wrapper script or task runner would leave
      // those children running (reparented to init) after the timeout fired.
      // There is no cooperating harness in this mode to time out a single
      // test against, only the whole invocation, so this timeout -- and the
      // whole-process-group kill behind it -- is what stands between a stuck
      // process and a `covsel record` that never returns.
      const harness = spawnDetached(bin, [...rest, ...args], { cwd: init.cwd });
      const timedOut = { current: false };
      const watchdog = setTimeout(() => {
        timedOut.current = true;
        harness.kill();
      }, testTimeoutMs);
      // Awaited via `.catch` rather than a `try`/`catch` around the whole
      // block, so a spawn failure (e.g. the binary does not exist) still
      // falls through to take and close the coverage session below exactly
      // as before -- a session opened for a test that never actually ran is
      // still a session that has to be closed, not one left dangling because
      // the error that explains why is thrown first.
      let spawnError: unknown;
      const outcome = await harness.result.catch((err: unknown) => {
        spawnError = err;
        return { status: null, signal: null, stdout: '', stderr: '' };
      });
      clearTimeout(watchdog);

      // An explicit, opt-in mitigation for server work that outlives this
      // invocation's own exit -- see `settleMs`'s own doc comment on
      // `HarnessServerConfig` for what this does and does not guarantee.
      if (settleMs !== undefined && settleMs > 0) {
        await sleep(settleMs);
      }

      let scripts;
      try {
        scripts = await session.take();
      } finally {
        await session.close();
      }

      if (spawnError) throw spawnError;
      if (timedOut.current) {
        throw new Error(
          `${testFile} did not finish within ${testTimeoutMs}ms -- treating the ` +
            'harness as stuck rather than waiting on it forever.',
        );
      }
      if (outcome.status !== 0) {
        const output = `${outcome.stdout}${outcome.stderr}`.trim();
        throw new Error(
          `the harness exited with ${outcome.status ?? `signal ${String(outcome.signal)}`} ` +
            `while running ${testFile}. A test that did not pass cannot be recorded: ` +
            `it may have stopped before running the part of itself that its ` +
            `coverage is really about.\n${output}`,
        );
      }

      const files = await mapper.toFiles({ scripts });
      const blocks = wantBlocks ? await mapper.toBlocks({ scripts }) : [];
      return [{ test: { file: testFile }, files, blocks }];
    },
    unmappableAllowed(): string[] {
      return mapper.takeAllowedUnmappable();
    },
  };
}
