import { Session } from 'node:inspector/promises';
import { stopCoverage, takeCoverage } from 'node:v8';

import { BOOT_MARKER_KEY, BootDeltaCoverage } from './boot-delta-coverage.js';
import type { Observer, RawCoverage } from './interfaces.js';
import type { ScriptCoverage } from './observer.js';
import type { TestId } from './schema.js';

function keyOf(id: TestId): string {
  return `${id.file} ${id.name ?? ''}`;
}

/**
 * Per-test coverage: which functions ran between the `before` and `after`
 * snapshots. Precise coverage counts are cumulative, so a function executed
 * during the window is one whose range count increased. Scripts and functions
 * compiled during the window (absent from `before`) are attributed in full.
 *
 * V8 reports only functions it has executed at least once, so an un-run function
 * is simply absent from the result — the delta is a positive signal of what ran,
 * not a per-function true/false. That is why per-test observation is used at
 * source-file granularity: a covered file is one the test actually executed.
 */
function deltaScripts(
  before: Map<string, ScriptCoverage>,
  after: Map<string, ScriptCoverage>,
): ScriptCoverage[] {
  const out: ScriptCoverage[] = [];
  for (const [url, script] of after) {
    const baseline = before.get(url);
    const functions: ScriptCoverage['functions'] = [];
    for (let i = 0; i < script.functions.length; i++) {
      const fn = script.functions[i]!;
      const base = baseline?.functions[i];
      const ranges = fn.ranges.map((r) => {
        // The index lookup above is only a hint — a function first run during the
        // window shifts indices. Matching ranges by offset is what keeps this
        // correct: a miss yields the full count (over-attribution), never an
        // under-count, so it stays fail-open.
        const br = base?.ranges.find(
          (x) => x.startOffset === r.startOffset && x.endOffset === r.endOffset,
        );
        return {
          startOffset: r.startOffset,
          endOffset: r.endOffset,
          count: r.count - (br?.count ?? 0),
        };
      });
      if (ranges.some((r) => r.count > 0)) {
        functions.push({
          ...(fn.functionName !== undefined ? { functionName: fn.functionName } : {}),
          ranges,
        });
      }
    }
    if (functions.length > 0) out.push({ url, functions });
  }
  return out;
}

/**
 * Per-test Observer: snapshot V8 precise coverage before and after each test via
 * the inspector and diff, attributing execution to the individual test rather
 * than the whole file. Runs in-process with the tests, so a runner adapter drives
 * it by calling `startTest(id)` / `endTest(id)` around each test (the only
 * per-runner code). The returned `RawCoverage` is V8 ScriptCoverage-shaped, so it
 * feeds the same `V8FileMapper` as the whole-file process observer.
 */
export class InspectorObserver implements Observer {
  private session: Session | undefined;
  private bootDelta: BootDeltaCoverage | undefined;
  private readonly baselines = new Map<string, Map<string, ScriptCoverage>>();

  /**
   * Begin observing. Idempotent.
   *
   * When this process was started with `NODE_V8_COVERAGE`, V8 has been
   * collecting precise coverage since bootstrap, so this takes the boot dump
   * instead: block-level detail for whatever this process loaded before its
   * first test, un-run functions included — the same mechanism the
   * Playwright adapter's server window uses for a target started the same
   * way. Without it, coverage has not been running before this call, and
   * there is nothing to see boot with; this falls back to today's per-test
   * inspector session, diffing a snapshot taken at each test's start against
   * one taken at its end.
   */
  async start(): Promise<void> {
    if (this.session ?? this.bootDelta) return;
    const dir = process.env.NODE_V8_COVERAGE;
    if (dir !== undefined && dir !== '') {
      const bootDelta = new BootDeltaCoverage({
        dir,
        pid: process.pid,
        trigger: async () => {
          takeCoverage();
        },
        readBootMarker: async () => {
          const marker = (globalThis as Record<symbol, unknown>)[
            Symbol.for(BOOT_MARKER_KEY)
          ];
          return typeof marker === 'string' ? marker : undefined;
        },
        writeBootMarker: async (dumpName) => {
          (globalThis as Record<symbol, unknown>)[Symbol.for(BOOT_MARKER_KEY)] = dumpName;
        },
      });
      await bootDelta.start();
      this.bootDelta = bootDelta;
      return;
    }
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true,
    });
    this.session = session;
  }

  private async snapshot(): Promise<Map<string, ScriptCoverage>> {
    if (!this.session)
      throw new Error('InspectorObserver not started; call start() first');
    const { result } = await this.session.post('Profiler.takePreciseCoverage');
    const byUrl = new Map<string, ScriptCoverage>();
    for (const script of result as ScriptCoverage[]) byUrl.set(script.url, script);
    return byUrl;
  }

  async startTest(id: TestId): Promise<void> {
    await this.start();
    if (this.bootDelta) return; // coverage has run since boot; nothing to baseline
    this.baselines.set(keyOf(id), await this.snapshot());
  }

  async endTest(id: TestId): Promise<RawCoverage> {
    if (this.bootDelta) return { scripts: await this.bootDelta.endTest() };
    const key = keyOf(id);
    const before = this.baselines.get(key) ?? new Map<string, ScriptCoverage>();
    const after = await this.snapshot();
    this.baselines.delete(key);
    return { scripts: deltaScripts(before, after) };
  }

  /** Stop coverage collection and disconnect. */
  async stop(): Promise<void> {
    if (this.bootDelta) {
      stopCoverage();
      this.bootDelta = undefined;
      return;
    }
    if (!this.session) return;
    await this.session.post('Profiler.stopPreciseCoverage');
    this.session.disconnect();
    this.session = undefined;
    this.baselines.clear();
  }
}
