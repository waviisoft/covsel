/**
 * @covsel/adapter-generic — the zero-integration, whole-file adapter.
 *
 * Wraps any runner command: each test *file* runs in its own process with
 * NODE_V8_COVERAGE set, yielding a per-file map with no runner integration.
 * Only selection formatting is implemented so far; coverage recording follows.
 */
import type { Adapter, TestId } from '@covsel/core';

export const genericAdapter: Adapter = {
  name: 'generic',
  formatSelection(tests: TestId[]): string[] {
    // Universal output contract: a newline-friendly list of test files.
    return [...new Set(tests.map((t) => t.file))];
  },
};
