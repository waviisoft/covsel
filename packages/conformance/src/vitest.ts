import { describe, it } from 'vitest';

import { conformanceCheckNames, runConformanceCheck } from './checks.js';
import type { AdapterConformanceSpec } from './spec.js';

export { RAN_MARKER_FILE } from './spec.js';
export type {
  AdapterConformanceSpec,
  ConformanceFixture,
  ConformanceUnit,
} from './spec.js';

export interface DescribeConformanceOptions {
  /** Per-check timeout; recording spawns a runner, so the default is generous. */
  timeout?: number;
}

/**
 * Register the conformance suite as vitest tests, one per check, so a failure
 * names the behaviour that broke rather than the whole suite. Adapters that do
 * not use vitest can call `runAdapterConformance` and assert on its report.
 */
export function describeAdapterConformance(
  spec: AdapterConformanceSpec,
  options: DescribeConformanceOptions = {},
): void {
  const timeout = options.timeout ?? 120_000;
  describe(`${spec.adapter.name} adapter conformance`, () => {
    for (const name of conformanceCheckNames) {
      it(
        name,
        async () => {
          await runConformanceCheck(spec, name);
        },
        timeout,
      );
    }
  });
}
