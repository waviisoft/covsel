/**
 * @covsel/adapter-generic -- the zero-integration, whole-file adapter.
 *
 * Wraps any runner command: each test *file* runs in its own process with
 * NODE_V8_COVERAGE set, yielding a per-file map with no runner integration.
 * Recording is core's own Observer piped into its Mapper -- no runner knowledge
 * is involved, which is exactly what makes this adapter work with anything that
 * executes its sources directly. It is covsel's default, and the baseline every
 * other adapter is an improvement on.
 *
 * Knowing nothing about the runner is also the limit of what it may claim. It
 * vouches for no command, so the recorder it builds declares no package
 * observation: whether a run executes all of its code in the process tree covsel
 * spawns is a fact about the command, and the adapter that wraps whatever it is
 * handed is the one that cannot know it. A generic recording therefore carries
 * no package information at all, and holds no opinion about a dependency change:
 * answering one is left to the lockfile sentinel, which the default `sentinels`
 * cover for npm, pnpm, and yarn.
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
    // Named through rather than forwarded whole, so "vouches for no command" is
    // a property of this code and not of what a caller happened to pass: an
    // init carrying the assertion cannot reach the recorder through here.
    const { command, cwd, config } = init;
    return createGenericRecorder({ command, cwd, config });
  },
};

/**
 * The export the dynamic resolver reads, so this package is selectable by its
 * specifier exactly as a third-party adapter is.
 */
export const adapter = genericAdapter;
