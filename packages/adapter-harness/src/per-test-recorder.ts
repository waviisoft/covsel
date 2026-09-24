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
import { spawnSync } from 'node:child_process';

import {
  type CovselConfig,
  type MapperConfig,
  type Recorder,
  type RecordedUnit,
  RemoteCoverageSession,
  V8FileMapper,
} from '@covsel/core';

import { DEFAULT_TEST_TIMEOUT_MS, type HarnessConfig } from './config.js';

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
      // `timeout` is the only bound this mode has on a hanging harness
      // process at all -- unlike the boundary protocol's own per-window
      // watchdog, there is no cooperating harness here to time out a single
      // test, only the whole invocation, so this is what stands between a
      // stuck process and a `covsel record` that never returns.
      const res = spawnSync(bin, [...rest, ...args], {
        cwd: init.cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: testTimeoutMs,
      });

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

      if (res.error) throw res.error;
      if (res.status !== 0) {
        const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
        throw new Error(
          `the harness exited with ${res.status ?? 'signal'} while running ` +
            `${testFile}. A test that did not pass cannot be recorded: it may ` +
            `have stopped before running the part of itself that its coverage ` +
            `is really about.\n${output}`,
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
