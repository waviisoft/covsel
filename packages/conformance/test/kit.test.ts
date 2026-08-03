import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type Adapter,
  createGenericRecorder,
  extractBlocks,
  MODULE_BLOCK,
  OBSERVES_EVERYTHING,
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

/**
 * The same unit, asserting on what it computed. Both units feed 2 through the
 * shared source — `alpha(1)` is `shared(1 * 2)`, `beta(1)` is `shared(1 + 1)` —
 * so both depend on the value the fixture's out-of-view code returns for 2, and
 * breaking that code fails both.
 */
const assertingTestFile = (label: string, source: string, fn: string) =>
  [
    "import { appendFileSync } from 'node:fs';",
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    `import { ${fn} } from '../${source}';`,
    `test('${fn}', () => {`,
    `  appendFileSync('${RAN_MARKER_FILE}', '${label}\\n');`,
    `  assert.equal(${fn}(1), 7);`,
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

/** An honest adapter: the whole-file recorder, and the file list every runner takes. */
const probeAdapter: Adapter = {
  name: 'probe',
  formatSelection: (tests) => [...new Set(tests.map((t) => t.file))],
  createRecorder: (init) => createGenericRecorder(init),
};

const conformingSpec: AdapterConformanceSpec = {
  adapter: probeAdapter,
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

/**
 * A fixture whose units reach code across a boundary a partial recorder cannot
 * see. `server/logic.mjs` stands in for the app server a browser test drives:
 * both units assert on a value it computes, and a recorder watching only the
 * browser side records nothing of it.
 */
const partialViewSpec: AdapterConformanceSpec = {
  adapter: probeAdapter,
  fixture: {
    ...conformingSpec.fixture,
    files: {
      'server/logic.mjs': 'export function price(qty) {\n  return qty * 3 + 1;\n}\n',
      'src/shared.mjs': [
        "import { price } from '../server/logic.mjs';",
        'export function shared(x) {',
        '  return price(x);',
        '}',
        '',
      ].join('\n'),
      'src/a.mjs': source('alpha', 'x * 2'),
      'src/b.mjs': source('beta', 'x + 1'),
      'test/a.test.mjs': assertingTestFile('test/a.test.mjs', 'src/a.mjs', 'alpha'),
      'test/b.test.mjs': assertingTestFile('test/b.test.mjs', 'src/b.mjs', 'beta'),
    },
    blindSpot: {
      source: 'server/logic.mjs',
      breakingEdit: { find: 'qty * 3 + 1', replace: 'qty * 9 + 1' },
    },
  },
};

/**
 * The package declaration of the recorder being wrapped.
 *
 * These stand-ins vary one thing each and pass the real recorder's units
 * through otherwise, packages included. Whatever the wrapped recorder declares
 * has to travel with them, or a wrapper would contradict its own units for a
 * reason none of these tests is about.
 *
 * The probe vouches for no command, so today there is no declaration to forward
 * and its units carry no packages. This keeps the two agreeing either way rather
 * than encoding which it currently is.
 */
function forwardPackageClaim(real: Recorder): { observesPackages?: boolean } {
  return real.observesPackages === undefined
    ? {}
    : { observesPackages: real.observesPackages };
}

/** The honest adapter, recording through it and then damaging what it reported. */
const derive = (
  damage: (
    unit: Awaited<ReturnType<Recorder['record']>>[number],
    cwd: string,
  ) => Awaited<ReturnType<Recorder['record']>>[number],
): Adapter => ({
  ...probeAdapter,
  createRecorder(init) {
    const real = probeAdapter.createRecorder(init);
    return {
      observes: real.observes,
      ...forwardPackageClaim(real),
      async record(file) {
        return (await real.record(file)).map((unit) => damage(unit, init.cwd));
      },
    };
  },
});

/** The honest adapter, recording everything it really saw but claiming otherwise. */
const declaring = (observes: readonly string[]): Adapter => ({
  ...probeAdapter,
  createRecorder: (init) => ({ ...probeAdapter.createRecorder(init), observes }),
});

/**
 * A recorder that watches only `src/`, the way a browser-side one sees the
 * bundle and nothing of the server behind it, declaring whatever it is told to.
 * What it records is plausible, non-empty, internally consistent, and missing a
 * whole region of the project.
 */
const partialView = (observes: readonly string[]): Adapter => ({
  ...probeAdapter,
  createRecorder(init) {
    const real = probeAdapter.createRecorder(init);
    const inView = (file: string): boolean => file.startsWith('src/');
    return {
      observes,
      ...forwardPackageClaim(real),
      async record(file) {
        return (await real.record(file)).map((unit) => ({
          ...unit,
          files: unit.files.filter((f) => inView(f.file)),
          blocks: unit.blocks.filter((b) => inView(b.file)),
        }));
      },
    };
  },
});

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
      adapter: { ...probeAdapter, formatSelection: (tests) => tests.map((t) => t.file) },
    });
    expect(check(results, 'formatSelection')?.ok).toBe(false);
  }, 180_000);

  it('fails a recorder that credits a test with code it never ran', async () => {
    const results = await runAdapterConformance({
      ...conformingSpec,
      adapter: derive((unit) => ({
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
      adapter: derive((unit) => ({
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
      adapter: derive((unit, cwd) => ({
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
      adapter: {
        ...probeAdapter,
        runSelection: ({ cwd }) =>
          spawnSync('node', ['--test'], { cwd, stdio: 'ignore' }).status ?? 1,
      },
    });
    expect(check(results, 'runs the units it names')?.ok).toBe(false);
  }, 180_000);

  it('fails an adapter whose run plan runs nothing and reports success', async () => {
    const results = await runAdapterConformance({
      ...conformingSpec,
      adapter: { ...probeAdapter, runSelection: () => 0 },
    });
    expect(check(results, 'runs the units it names')?.ok).toBe(false);
  }, 180_000);

  it('fails a recorder that records nothing at all', async () => {
    const results = await runAdapterConformance({
      ...conformingSpec,
      adapter: {
        ...probeAdapter,
        createRecorder: () => ({
          observes: OBSERVES_EVERYTHING,
          async record() {
            return [];
          },
        }),
      },
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

  it('passes a whole-process adapter on a fixture that has a blind spot', async () => {
    // Nothing is outside `**`, so the out-of-view source is ordinary code the
    // recorder is expected to have recorded like any other.
    const results = await runAdapterConformance(partialViewSpec);
    expect(results.filter((r) => !r.ok).map((f) => `${f.check}: ${f.detail}`)).toEqual(
      [],
    );
  }, 180_000);

  it('certifies a recorder that declares the part of the run it sees', async () => {
    // The honest partial recorder: it records only src/, says so, and every
    // check — including the new one — holds it to exactly that.
    const results = await runAdapterConformance({
      ...partialViewSpec,
      adapter: partialView(['src/**', 'test/**']),
    });
    expect(results.filter((r) => !r.ok).map((f) => `${f.check}: ${f.detail}`)).toEqual(
      [],
    );
  }, 180_000);

  it('fails a recorder that sees part of the run and claims it saw everything', async () => {
    // The shape the whole check exists for: what it reports is plausible,
    // non-empty, deterministic, precise, and blind to server/. Every other check
    // passes, because under-recording is if anything *more* precise.
    const results = await runAdapterConformance({
      ...partialViewSpec,
      adapter: partialView(OBSERVES_EVERYTHING),
    });
    const blind = check(results, 'blind spots');
    expect(blind?.ok).toBe(false);
    expect(blind?.detail).toContain('server/logic.mjs');
    expect(
      results.filter((r) => !r.ok).map((r) => r.check),
      'nothing else in the suite notices a partial view',
    ).toEqual([blind?.check]);
  }, 180_000);

  it('fails a recorder that records a source it declared it could not see', async () => {
    // Narrowed its declaration and not its recording: it says it watches the
    // source root and still reports everything its coverage data contained.
    const results = await runAdapterConformance({
      ...partialViewSpec,
      adapter: declaring(['src/**']),
    });
    const blind = check(results, 'blind spots');
    expect(blind?.ok).toBe(false);
    expect(blind?.detail).toContain('server/logic.mjs');
  }, 180_000);

  it('rejects a fixture that never exercises a narrow declaration', async () => {
    // A declaration narrower than the whole repo, and a fixture with nothing
    // outside it: the claim is never put to the test, and a recorder blind past
    // it certifies green. Every file here is inside the declared scope, which is
    // what makes the fixture's file list the wrong thing to ask.
    const results = await runAdapterConformance({
      ...conformingSpec,
      adapter: declaring(['src/**', 'test/**']),
    });
    const blind = check(results, 'blind spots');
    expect(blind?.ok).toBe(false);
    expect(blind?.detail).toContain('blindSpot');
  }, 180_000);

  it('rejects a blind spot inside the scope of a partial declaration', async () => {
    const results = await runAdapterConformance({
      ...partialViewSpec,
      adapter: declaring(['src/**', 'test/**', 'server/**']),
    });
    const blind = check(results, 'blind spots');
    expect(blind?.ok).toBe(false);
    expect(blind?.detail).toContain('server/logic.mjs');
  }, 180_000);

  it('certifies a partial recorder over a fixture file nothing executes', async () => {
    // An asset outside the declared scope is not a blind spot: no unit executes
    // it, so no blindSpot an author could write would exercise the declaration
    // through it, and demanding one would reject a correct adapter over a README.
    const results = await runAdapterConformance({
      ...partialViewSpec,
      adapter: partialView(['src/**', 'test/**']),
      fixture: {
        ...partialViewSpec.fixture,
        files: { ...partialViewSpec.fixture.files, 'README.md': '# fixture\n' },
      },
    });
    expect(results.filter((r) => !r.ok).map((f) => `${f.check}: ${f.detail}`)).toEqual(
      [],
    );
  }, 180_000);

  it('rejects a blind spot the fixture does not execute', async () => {
    const results = await runAdapterConformance({
      ...partialViewSpec,
      adapter: partialView(['src/**', 'test/**']),
      fixture: {
        ...partialViewSpec.fixture,
        files: {
          ...partialViewSpec.fixture.files,
          'server/unused.mjs': 'export function idle() {\n  return 1;\n}\n',
        },
        blindSpot: {
          source: 'server/unused.mjs',
          breakingEdit: { find: 'return 1', replace: 'return missing' },
        },
      },
    });
    const blind = check(results, 'blind spots');
    expect(blind?.ok).toBe(false);
    expect(blind?.detail).toContain('server/unused.mjs');
  }, 180_000);

  it('rejects a blind spot nothing reaches even when the runner reports failure', async () => {
    // A non-zero exit is not proof that the edit broke anything: a runner that
    // runs no tests and reports failure produces the same one. The units have to
    // be shown passing first, and shown running.
    const results = await runAdapterConformance({
      ...partialViewSpec,
      adapter: { ...partialView(['src/**', 'test/**']), runSelection: () => 1 },
      fixture: {
        ...partialViewSpec.fixture,
        files: {
          ...partialViewSpec.fixture.files,
          'server/unused.mjs': 'export function idle() {\n  return 1;\n}\n',
        },
        blindSpot: {
          source: 'server/unused.mjs',
          breakingEdit: { find: 'return 1', replace: 'return missing' },
        },
      },
    });
    expect(check(results, 'blind spots')?.ok).toBe(false);
  }, 180_000);

  it('rejects a blind spot naming a test file', async () => {
    const results = await runAdapterConformance({
      ...partialViewSpec,
      fixture: {
        ...partialViewSpec.fixture,
        blindSpot: {
          source: 'test/a.test.mjs',
          breakingEdit: { find: 'assert.equal', replace: 'assert.notEqual' },
        },
      },
    });
    // A test file is selected whether or not the recording could observe it, so
    // it can never show that the declared scope was what caused the full run.
    expect(check(results, 'records a usable map')?.ok).toBe(false);
    expect(check(results, 'records a usable map')?.detail).toContain('test/a.test.mjs');
  }, 180_000);

  it('rejects a blind spot that would force a full run anyway', async () => {
    const results = await runAdapterConformance({
      ...partialViewSpec,
      adapter: partialView(['src/**', 'test/**']),
      fixture: {
        ...partialViewSpec.fixture,
        files: {
          ...partialViewSpec.fixture.files,
          'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
        },
        blindSpot: {
          source: 'tsconfig.json',
          breakingEdit: { find: 'true', replace: 'false' },
        },
      },
    });
    // A sentinel forces a full run whatever the recording observed, so it can
    // never show that the declared scope is what caused one.
    expect(check(results, 'records a usable map')?.ok).toBe(false);
    expect(check(results, 'records a usable map')?.detail).toContain('tsconfig.json');
  }, 180_000);
});
