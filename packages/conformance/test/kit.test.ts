import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createGenericRecorder,
  extractBlocks,
  MODULE_BLOCK,
  type Recorder,
} from '@covsel/core';

import {
  type AdapterConformanceSpec,
  conformanceCheckNames,
  RAN_MARKER_FILE,
  runAdapterConformance,
} from '../src/index.js';

/**
 * A conformance suite that cannot fail is a rubber stamp. These tests break an
 * adapter on purpose and assert the suite catches it, so the checks keep their
 * teeth as the kit grows.
 *
 * The broken adapters here are *structural* — depth-limited, block-truncating,
 * selection-ignoring. An adapter broken by deleting the exact path a check names
 * proves only that the check reads its own argument; it models nothing anyone
 * would ship, and a suite validated that way stays green through real bugs.
 */

const testFile = (label: string, source: string, fn: string) =>
  [
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `import { ${fn} } from '../${source}';`,
    `test('${fn}', () => {`,
    `  appendFileSync('${RAN_MARKER_FILE}', '${label}\\n');`,
    `  ${fn}(1);`,
    '});',
    '',
  ].join('\n');

const source = (fn: string, expr: string) =>
  [
    "import { shared } from './shared.mjs';",
    `export function ${fn}(x) {`,
    `  return shared(${expr});`,
    '}',
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
      'src/shared.mjs': 'export function shared(x) {\n  return x + 0;\n}\n',
      'src/a.mjs': source('alpha', 'x * 2'),
      'src/b.mjs': source('beta', 'x + 1'),
      'test/a.test.mjs': testFile('test/a.test.mjs', 'src/a.mjs', 'alpha'),
      'test/b.test.mjs': testFile('test/b.test.mjs', 'src/b.mjs', 'beta'),
    },
    units: {
      a: {
        testFile: 'test/a.test.mjs',
        source: 'src/a.mjs',
        bodyEdit: { find: 'shared(x * 2)', replace: 'shared(x * 3)' },
      },
      b: {
        testFile: 'test/b.test.mjs',
        source: 'src/b.mjs',
        bodyEdit: { find: 'shared(x + 1)', replace: 'shared(x + 2)' },
      },
    },
    sharedSource: 'src/shared.mjs',
    newTest: {
      file: 'test/c.test.mjs',
      contents: "import { test } from 'node:test';\ntest('c', () => {});\n",
    },
  },
};

/** Wrap the honest recorder, then damage what it reported. */
const derive = (
  damage: (
    unit: Awaited<ReturnType<Recorder['record']>>[number],
    cwd: string,
  ) => Awaited<ReturnType<Recorder['record']>>[number],
): AdapterConformanceSpec['createRecorder'] => {
  return (init) => {
    const real = conformingSpec.createRecorder(init);
    return {
      async record(file) {
        return (await real.record(file)).map((unit) => damage(unit, init.cwd));
      },
    };
  };
};

const check = (
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
    expect(check(results, 'formatSelection')?.ok).toBe(false);
  }, 180_000);

  it('fails a recorder that credits a test with code it never ran', async () => {
    const results = await runAdapterConformance({
      ...conformingSpec,
      createRecorder: derive((unit) => ({
        ...unit,
        files: [
          { file: 'src/a.mjs', fileHash: 'sha256:stub' },
          { file: 'src/b.mjs', fileHash: 'sha256:stub' },
        ],
      })),
    });
    expect(check(results, 'attributes each unit')?.ok).toBe(false);
  }, 180_000);

  it('fails a recorder that never follows an import', async () => {
    // Credits a test with the files its own test file names and nothing those
    // reach in turn. Precise, deterministic, and fails open on new tests and
    // sentinels — it just quietly misses everything at depth. This is the shape
    // that certified green before the shared source had to be indirect.
    const direct = new Set(['src/a.mjs', 'src/b.mjs']);
    const results = await runAdapterConformance({
      ...conformingSpec,
      createRecorder: derive((unit) => ({
        ...unit,
        files: unit.files.filter((f) => direct.has(f.file)),
        ...(unit.blocks ? { blocks: unit.blocks.filter((b) => direct.has(b.file)) } : {}),
      })),
    });
    expect(check(results, 'every source it executes')?.ok).toBe(false);
    expect(check(results, 'shared source selects both')?.ok).toBe(false);
  }, 180_000);

  it('fails a recorder that records only module blocks', async () => {
    // Every file correct, every block a module skeleton. Appending to a source
    // still selects, so this passes everything except a change inside a function
    // — which is most changes anyone actually makes.
    const moduleHash = (cwd: string, rel: string): string | undefined =>
      extractBlocks(readFileSync(join(cwd, rel), 'utf8'), rel).find(
        (b) => b.name === MODULE_BLOCK,
      )?.hash;
    const results = await runAdapterConformance({
      ...conformingSpec,
      createRecorder: derive((unit, cwd) => ({
        ...unit,
        ...(unit.blocks
          ? {
              blocks: unit.blocks.filter((b) => b.blockHash === moduleHash(cwd, b.file)),
            }
          : {}),
      })),
    });
    expect(check(results, 'function body')?.ok).toBe(false);
  }, 180_000);

  it('fails an adapter whose run plan ignores the selection', async () => {
    const results = await runAdapterConformance({
      ...conformingSpec,
      // Runs the whole suite whatever it was handed — green, and useless.
      runSelection: ({ cwd }) =>
        spawnSync('node', ['--test'], { cwd, stdio: 'ignore' }).status ?? 1,
    });
    expect(check(results, 'runs the units it names')?.ok).toBe(false);
  }, 180_000);

  it('fails an adapter whose run plan runs nothing and reports success', async () => {
    const results = await runAdapterConformance({
      ...conformingSpec,
      runSelection: () => 0,
    });
    expect(check(results, 'runs the units it names')?.ok).toBe(false);
  }, 180_000);

  it('fails a recorder that records nothing at all', async () => {
    const results = await runAdapterConformance({
      ...conformingSpec,
      createRecorder: () => ({
        async record() {
          return [];
        },
      }),
    });
    expect(check(results, 'records a usable map')?.ok).toBe(false);
  }, 180_000);

  it('rejects a fixture whose shared source is a direct import', async () => {
    const results = await runAdapterConformance({
      ...conformingSpec,
      fixture: {
        ...conformingSpec.fixture,
        files: {
          ...conformingSpec.fixture.files,
          'test/a.test.mjs': `import { shared } from '../src/shared.mjs';\n${conformingSpec.fixture.files['test/a.test.mjs']!}`,
        },
      },
    });
    // Every check that builds a project must refuse it, not quietly measure less.
    expect(check(results, 'records a usable map')?.ok).toBe(false);
    expect(check(results, 'records a usable map')?.detail).toContain('shared');
  }, 180_000);
});
