/**
 * @covsel/adapter-generic — the zero-integration, whole-file adapter.
 *
 * Wraps any runner command: each test *file* runs in its own process with
 * NODE_V8_COVERAGE set, yielding a per-file map with no runner integration.
 * Recording is core's own Observer piped into its Mapper — no runner knowledge
 * is involved, which is exactly what makes this adapter work with anything that
 * executes its sources directly. It is covsel's default, and the baseline every
 * other adapter is an improvement on.
 */
import {
  type Adapter,
  createGenericRecorder,
  type Recorder,
  type RecorderInit,
  type TestId,
} from '@covsel/core';

export const genericAdapter: Adapter = {
  name: 'generic',
  formatSelection(tests: TestId[]): string[] {
    // Universal output contract: a newline-friendly list of test files.
    return [...new Set(tests.map((t) => t.file))];
  },
  createRecorder(init: RecorderInit): Recorder {
    return createGenericRecorder(init);
  },
};
