import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type Adapter,
  DEFAULT_CONFIG,
  resolveConfigFor,
  runSelected,
  type SelectionRunInit,
  type TestId,
} from '../src/index.js';

/**
 * The contract's dispatch, not any one runner: what a consumer gets for an
 * adapter that only formats a file list, and what changes when it can narrow the
 * run itself. `covsel run` and the conformance suite both come through here, so
 * a regression in this dispatch is a regression in both at once.
 */

const fileList = (tests: TestId[]): string[] => [...new Set(tests.map((t) => t.file))];

/** Records what it was handed instead of spawning anything. */
function spyAdapter(overrides: Partial<Adapter> = {}): {
  adapter: Adapter;
  calls: SelectionRunInit[];
} {
  const calls: SelectionRunInit[] = [];
  const adapter: Adapter = {
    name: 'spy',
    formatSelection: fileList,
    createRecorder: () => ({
      async record() {
        return [];
      },
    }),
    runSelection(init: SelectionRunInit): number {
      calls.push(init);
      return 0;
    },
    ...overrides,
  };
  return { adapter, calls };
}

describe('the adapter capability contract', () => {
  it('hands the selection to an adapter that can narrow the run itself', () => {
    const { adapter, calls } = spyAdapter();
    const selected: TestId[] = [
      { file: 'suite.test.mjs', name: 'alpha' },
      { file: 'other.test.mjs' },
    ];

    const outcome = runSelected({
      adapter,
      selected,
      command: ['node', '--test'],
      cwd: '/nowhere',
    });

    expect(outcome.status).toBe(0);
    expect(calls).toHaveLength(1);
    // The per-test names survive: collapsing to files here would silently widen
    // every per-test adapter's run back to whole files.
    expect(calls[0]?.selected).toEqual(selected);
    expect(calls[0]?.command).toEqual(['node', '--test']);
  });

  it('appends the formatted file list for an adapter that cannot', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-dispatch-'));
    try {
      // Writes the arguments it received, so the assertion is on the real
      // invocation rather than on a mock of it.
      writeFileSync(
        join(cwd, 'echo-args.mjs'),
        "import { writeFileSync } from 'node:fs';\n" +
          "writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));\n",
      );
      const adapter: Adapter = {
        name: 'file-list',
        formatSelection: fileList,
        createRecorder: () => ({
          async record() {
            return [];
          },
        }),
      };

      const outcome = runSelected({
        adapter,
        selected: [
          { file: 'test/a.test.mjs', name: 'one' },
          { file: 'test/a.test.mjs', name: 'two' },
          { file: 'test/b.test.mjs' },
        ],
        command: ['node', 'echo-args.mjs', '--flag'],
        cwd,
        stdio: 'ignore',
      });

      expect(outcome.status).toBe(0);
      expect(
        JSON.parse(readFileSync(join(cwd, 'args.json'), 'utf8')),
        'per-test ids of one file collapse to that file once',
      ).toEqual(['--flag', 'test/a.test.mjs', 'test/b.test.mjs']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('captures the runner output it is not passing through, so a failure is diagnosable', () => {
    const adapter: Adapter = {
      name: 'file-list',
      formatSelection: fileList,
      createRecorder: () => ({
        async record() {
          return [];
        },
      }),
    };
    const outcome = runSelected({
      adapter,
      selected: [{ file: 'boom.test.mjs' }],
      command: ['node', '-e', 'console.error("boom"); process.exit(3)'],
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    expect(outcome.status).toBe(3);
    expect(outcome.output).toContain('boom');
  });

  it('runs nothing for an empty selection, whichever path an adapter takes', () => {
    // Appending an empty file list would hand the runner its whole suite — the
    // one way "no affected tests" could turn into "run everything", and a
    // difference between the two dispatch paths if it were left to each of them.
    const { adapter: narrowing, calls } = spyAdapter();
    const fileListOnly: Adapter = {
      name: 'file-list',
      formatSelection: fileList,
      createRecorder: narrowing.createRecorder,
    };
    for (const adapter of [narrowing, fileListOnly]) {
      const outcome = runSelected({
        adapter,
        selected: [],
        // Would exit 7 if it were ever spawned.
        command: ['node', '-e', 'process.exit(7)'],
        cwd: process.cwd(),
      });
      expect(outcome.status).toBe(0);
    }
    expect(calls, 'an empty selection never reaches the runner').toEqual([]);
  });

  it("lets an adapter's default test globs stand in, and the project overrule them", () => {
    const { adapter } = spyAdapter({ defaultTestGlobs: ['**/*.feature'] });
    expect(resolveConfigFor(adapter).testGlobs).toEqual(['**/*.feature']);
    expect(resolveConfigFor(adapter, { testGlobs: ['spec/**'] }).testGlobs).toEqual([
      'spec/**',
    ]);
    // An adapter without the capability leaves discovery exactly as it was.
    const { adapter: plain } = spyAdapter();
    expect(resolveConfigFor(plain).testGlobs).toEqual(DEFAULT_CONFIG.testGlobs);
  });
});
