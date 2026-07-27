import { describe, expect, it } from 'vitest';

import { createGenericRecorder, type Recorder } from '@covsel/core';

import {
  type AdapterConformanceSpec,
  conformanceCheckNames,
  runAdapterConformance,
} from '../src/index.js';

/**
 * A conformance suite that cannot fail is a rubber stamp. These tests break an
 * adapter on purpose and assert the suite catches it, so the checks keep their
 * teeth as the kit grows.
 */

const testFile = (source: string, fn: string) =>
  [
    "import { test } from 'node:test';",
    `import { ${fn} } from '../${source}';`,
    `test('${fn}', () => { ${fn}(1); });`,
    '',
  ].join('\n');

const conformingSpec: AdapterConformanceSpec = {
  adapter: {
    name: 'probe',
    formatSelection: (tests) => [...new Set(tests.map((t) => t.file))],
  },
  createRecorder: ({ cwd, config }) =>
    createGenericRecorder({ command: ['node', '--test'], cwd, config }),
  fixture: {
    command: ['node', '--test'],
    files: {
      'src/a.mjs': 'export function alpha(x) {\n  return x * 2;\n}\n',
      'src/b.mjs': 'export function beta(x) {\n  return x + 1;\n}\n',
      'test/a.test.mjs': testFile('src/a.mjs', 'alpha'),
      'test/b.test.mjs': testFile('src/b.mjs', 'beta'),
    },
    units: {
      a: { testFile: 'test/a.test.mjs', source: 'src/a.mjs' },
      b: { testFile: 'test/b.test.mjs', source: 'src/b.mjs' },
    },
    newTest: {
      file: 'test/c.test.mjs',
      contents: "import { test } from 'node:test';\ntest('c', () => {});\n",
    },
  },
};

const failed = (
  results: Awaited<ReturnType<typeof runAdapterConformance>>,
  needle: string,
) => results.find((r) => r.check.includes(needle));

describe('the conformance kit', () => {
  it('exposes every check by name', () => {
    expect(conformanceCheckNames.length).toBeGreaterThan(0);
    expect(new Set(conformanceCheckNames).size).toBe(conformanceCheckNames.length);
  });

  it('passes an adapter that behaves', async () => {
    const results = await runAdapterConformance(conformingSpec);
    const failures = results.filter((r) => !r.ok);
    expect(
      failures.map((f) => `${f.check}: ${f.detail}`),
      'a conforming adapter must pass every check',
    ).toEqual([]);
  }, 180_000);

  it('fails an adapter whose formatSelection does not deduplicate', async () => {
    const results = await runAdapterConformance({
      ...conformingSpec,
      adapter: {
        name: 'bad-format',
        formatSelection: (tests) => tests.map((t) => t.file),
      },
    });
    expect(failed(results, 'formatSelection')?.ok).toBe(false);
  }, 180_000);

  it('fails a recorder that credits a test with code it never ran', async () => {
    const overAttributing: AdapterConformanceSpec['createRecorder'] = (init) => {
      const real = conformingSpec.createRecorder(init);
      const recorder: Recorder = {
        async record(file) {
          const units = await real.record(file);
          return units.map((unit) => ({
            ...unit,
            files: [
              { file: 'src/a.mjs', fileHash: 'sha256:stub' },
              { file: 'src/b.mjs', fileHash: 'sha256:stub' },
            ],
          }));
        },
      };
      return recorder;
    };
    const results = await runAdapterConformance({
      ...conformingSpec,
      createRecorder: overAttributing,
    });
    expect(failed(results, 'attributes each unit')?.ok).toBe(false);
  }, 180_000);

  it('fails a recorder that records nothing at all', async () => {
    const empty: AdapterConformanceSpec['createRecorder'] = () => ({
      async record() {
        return [];
      },
    });
    const results = await runAdapterConformance({
      ...conformingSpec,
      createRecorder: empty,
    });
    expect(failed(results, 'records a usable map')?.ok).toBe(false);
  }, 180_000);
});
