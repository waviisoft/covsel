/**
 * @covsel/adapter-generic — Level 0, zero-integration adapter.
 *
 * Wraps any runner command: each test *file* runs in its own process with
 * NODE_V8_COVERAGE set, yielding a per-file map with no runner integration.
 * Implementation lands in Milestone 1 (Issue #14).
 */
import type { Adapter, TestId } from '@covsel/core';

export const genericAdapter: Adapter = {
  name: 'generic',
  formatSelection(tests: TestId[]): string[] {
    // Universal output contract: a newline-friendly list of test files.
    return [...new Set(tests.map((t) => t.file))];
  },
};
