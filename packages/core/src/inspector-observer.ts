import { Session } from 'node:inspector/promises';

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
 * Level-1 Observer: snapshot V8 precise coverage before and after each test via
 * the inspector and diff, attributing execution to the individual test rather
 * than the whole file. Runs in-process with the tests, so a runner adapter drives
 * it by calling `startTest(id)` / `endTest(id)` around each test (the only
 * per-runner code). The returned `RawCoverage` is V8 ScriptCoverage-shaped, so it
 * feeds the same `V8FileMapper` as the Level-0 process observer.
 */
export class InspectorObserver implements Observer {
  private session: Session | undefined;
  private readonly baselines = new Map<string, Map<string, ScriptCoverage>>();

  /** Connect the inspector session and begin precise coverage. Idempotent. */
  async start(): Promise<void> {
    if (this.session) return;
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
    this.baselines.set(keyOf(id), await this.snapshot());
  }

  async endTest(id: TestId): Promise<RawCoverage> {
    const key = keyOf(id);
    const before = this.baselines.get(key) ?? new Map<string, ScriptCoverage>();
    const after = await this.snapshot();
    this.baselines.delete(key);
    return { scripts: deltaScripts(before, after) };
  }

  /** Stop precise coverage and disconnect the session. */
  async stop(): Promise<void> {
    if (!this.session) return;
    await this.session.post('Profiler.stopPreciseCoverage');
    this.session.disconnect();
    this.session = undefined;
    this.baselines.clear();
  }
}
