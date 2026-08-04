import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commitAll, write } from './helpers/repo.js';
import {
  type CovselConfig,
  OBSERVES_EVERYTHING,
  recordMap,
  type Recorder,
  type RecordedUnit,
  resolveConfig,
} from '../src/index.js';

/**
 * Recording a whole run in one invocation.
 *
 * Every recorder so far is driven file by file, which gives covsel a safety
 * property for free: it knows which file it asked about, so a file that yields
 * nothing is visibly a shortfall. A recorder that records the entire suite in
 * one go loses that — a test the run never reports back is indistinguishable
 * from a test that covered nothing, and "covers nothing" is read by selection as
 * "no test to run". These are the rules that keep the second mode as safe as
 * the first.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(over: Partial<CovselConfig> = {}): {
  cwd: string;
  config: CovselConfig;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-record-run-'));
  dirs.push(cwd);
  write(cwd, 'src/cart.mjs', 'export const total = (q) => q * 3;\n');
  write(cwd, 'src/profile.mjs', 'export const name = () => "ada";\n');
  write(cwd, 'test/cart.test.mjs', '// driven by the runner\n');
  write(cwd, 'test/profile.test.mjs', '// driven by the runner\n');
  commitAll(cwd);
  return { cwd, config: resolveConfig(over) };
}

const unitFor = (file: string, source: string, name?: string): RecordedUnit => ({
  test: { file, ...(name !== undefined ? { name } : {}) },
  files: [{ file: source, fileHash: `sha256:${source}` }],
  blocks: [],
});

/** A recorder that records the whole suite in one invocation. */
function runRecorder(
  units: (testFiles: readonly string[]) => RecordedUnit[],
  over: Partial<Recorder> = {},
): Recorder {
  return {
    observes: OBSERVES_EVERYTHING,
    async recordRun(testFiles: readonly string[]) {
      return units(testFiles);
    },
    ...over,
  } as Recorder;
}

describe('a recorder that records the whole run at once', () => {
  it('is invoked once, with every discovered test file', async () => {
    const { cwd, config } = fixture();
    const invocations: (readonly string[])[] = [];
    const recorder = runRecorder((testFiles) => {
      invocations.push(testFiles);
      return testFiles.map((f) => unitFor(f, 'src/cart.mjs'));
    });

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(true);
    expect(invocations).toHaveLength(1);
    expect([...(invocations[0] as readonly string[])].sort()).toEqual([
      'test/cart.test.mjs',
      'test/profile.test.mjs',
    ]);
  });

  it('records a unit per test, not per file', async () => {
    const { cwd, config } = fixture();
    const recorder = runRecorder(() => [
      unitFor('test/cart.test.mjs', 'src/cart.mjs', 'adds'),
      unitFor('test/cart.test.mjs', 'src/cart.mjs', 'removes'),
      unitFor('test/profile.test.mjs', 'src/profile.mjs', 'shows'),
    ]);

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(true);
    expect(result.map!.entries.map((e) => e.test.name)).toEqual([
      'adds',
      'removes',
      'shows',
    ]);
  });

  it('fails the recording when a discovered test file went unreported', async () => {
    const { cwd, config } = fixture();
    // The run came back with cart only. In file-per-invocation mode covsel would
    // have asked about profile and seen it yield nothing; here the silence has
    // to be caught by reconciliation instead.
    const recorder = runRecorder(() => [unitFor('test/cart.test.mjs', 'src/cart.mjs')]);

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.file)).toEqual(['test/profile.test.mjs']);
    expect(result.failures[0]!.reason).toMatch(/report/i);
    expect(existsSync(result.mapPath)).toBe(false);
  });

  it('writes no map when the run throws partway', async () => {
    const { cwd, config } = fixture();
    const recorder: Recorder = {
      observes: OBSERVES_EVERYTHING,
      async recordRun() {
        throw new Error('the runner exited 1');
      },
    } as Recorder;

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    // A run that died partway is not attributable to one file, so it is reported
    // as the recording failing rather than as a per-file failure.
    expect(result.error).toMatch(/exited 1/);
    expect(result.failures).toEqual([]);
    expect(existsSync(result.mapPath)).toBe(false);
  });

  it('holds a unit to the recorder’s declared scope, as the per-file path does', async () => {
    const { cwd, config } = fixture();
    const recorder = runRecorder(
      (testFiles) =>
        testFiles.map((f) => ({
          ...unitFor(f, 'src/cart.mjs'),
          observes: ['src/**', 'server/**'],
        })),
      { observes: ['src/**'] },
    );

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    expect(result.failures[0]!.reason).toMatch(/server\/\*\*/);
    expect(existsSync(result.mapPath)).toBe(false);
  });

  it('reports one recorded event per test file, as the per-file path does', async () => {
    const { cwd, config } = fixture();
    const events: { kind: string; file?: string; tests?: number }[] = [];
    // Reported profile-first, so an implementation emitting events in the order
    // the run reported would not produce discovery order by accident.
    const recorder = runRecorder(() => [
      unitFor('test/profile.test.mjs', 'src/profile.mjs', 'shows'),
      unitFor('test/cart.test.mjs', 'src/cart.mjs', 'adds'),
      unitFor('test/cart.test.mjs', 'src/cart.mjs', 'removes'),
    ]);

    await recordMap({ cwd, config, recorder, onEvent: (e) => events.push(e) });

    const recorded = events.filter((e) => e.kind === 'recorded');
    expect(recorded.map((e) => [e.file, e.tests])).toEqual([
      ['test/cart.test.mjs', 2],
      ['test/profile.test.mjs', 1],
    ]);
  });

  it('refuses a recorder that offers neither way to record', async () => {
    const { cwd, config } = fixture();
    const recorder = { observes: OBSERVES_EVERYTHING } as unknown as Recorder;

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    // The branch's own message, not merely "something mentioning record": a
    // TypeError from calling an absent `record` is also ok:false, also writes no
    // map, and also matches /record/, so a looser assertion constrains nothing.
    expect(result.error).toMatch(/neither `record` nor `recordRun`/);
    expect(existsSync(result.mapPath)).toBe(false);
  });

  it('keeps units for a file discovery never found, and still records the rest', async () => {
    const { cwd, config } = fixture();
    const recorder = runRecorder((testFiles) => [
      ...testFiles.map((f) => unitFor(f, 'src/cart.mjs')),
      // A spec the runner executed that covsel's testGlobs do not match. Kept
      // rather than refused: selection never consults it, and failing a whole
      // recording over a discovery disagreement is the harsher reading.
      unitFor('e2e/checkout.spec.mjs', 'src/profile.mjs'),
    ]);

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(true);
    expect(result.map!.entries.map((e) => e.test.file)).toContain(
      'e2e/checkout.spec.mjs',
    );
  });

  it('fails the recording when an undiscovered file’s unit breaks a rule', async () => {
    const { cwd, config } = fixture();
    const recorder = runRecorder(
      (testFiles) => [
        ...testFiles.map((f) => unitFor(f, 'src/cart.mjs')),
        {
          ...unitFor('e2e/checkout.spec.mjs', 'src/profile.mjs'),
          observes: ['server/**'],
        },
      ],
      { observes: ['src/**'] },
    );

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.file)).toEqual(['e2e/checkout.spec.mjs']);
    expect(existsSync(result.mapPath)).toBe(false);
  });

  it('reports what the run let through unmapped against the run, not against every file', async () => {
    const { cwd, config } = fixture();
    const events: { kind: string; file?: string; allowedUnmappable?: string[] }[] = [];
    const recorder = runRecorder(
      (testFiles) => testFiles.map((f) => unitFor(f, 'src/cart.mjs')),
      {
        unmappableAllowed: () => ['dist/bundle.mjs'],
      },
    );

    await recordMap({ cwd, config, recorder, onEvent: (e) => events.push(e) });

    // One invocation covered the whole suite, so naming the script on each
    // file's event would claim every file executed it.
    const naming = events.filter((e) => e.allowedUnmappable !== undefined);
    expect(naming).toHaveLength(1);
    expect(naming[0]!.file).toBe('(the run)');
  });

  it('reports a run that resolves to something that is not a list of units', async () => {
    const { cwd, config } = fixture();
    const recorder = {
      observes: OBSERVES_EVERYTHING,
      async recordRun() {
        return undefined;
      },
    } as unknown as Recorder;

    // An adapter built against an older core, or one missing a `return`. It must
    // be reported the way any other recording failure is, not escape as an
    // unhandled rejection that loses covsel's own messaging.
    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(existsSync(result.mapPath)).toBe(false);
  });

  it('still drives a per-file recorder one file at a time', async () => {
    const { cwd, config } = fixture();
    const asked: string[] = [];
    const recorder: Recorder = {
      observes: OBSERVES_EVERYTHING,
      async record(file: string) {
        asked.push(file);
        return [unitFor(file, 'src/cart.mjs')];
      },
    };

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(true);
    expect(asked.sort()).toEqual(['test/cart.test.mjs', 'test/profile.test.mjs']);
  });
});
