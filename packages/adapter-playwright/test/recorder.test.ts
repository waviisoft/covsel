import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfig } from '@covsel/core';

import { createPlaywrightRecorder, playwrightAdapter } from '../src/index.js';

/**
 * The recorder's half of the protocol, exercised against a stand-in for
 * `playwright test`.
 *
 * What is being checked is the shape of a *whole-run* recording: covsel asks
 * once, the runner reports per test, and everything that could leave the map
 * quietly short of a test's coverage has to fail the recording instead. The
 * browser is beside the point here — a fake runner writing the same lines the
 * fixture writes exercises every one of those rules, and does it in
 * milliseconds.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A window the fixture would have written for a test that covered `file`. */
const covering = (file: string) => ({
  files: [{ file, fileHash: 'h' }],
  blocks: [{ file, blockHash: 'b' }],
});

interface FakeRun {
  /** Lines to write, as objects, distributed across `workers` output files. */
  records?: unknown[];
  /** How many worker files those records are spread over. */
  workers?: number;
  /** Exit code for the fake runner. */
  status?: number;
  /** Raw text appended to the first worker file, for malformed-line cases. */
  raw?: string;
}

/**
 * A project holding a stand-in runner. It writes what the fixture would have
 * written, records the argv it was invoked with, and exits with whatever the
 * case needs.
 */
function project(run: FakeRun): { cwd: string; command: string[]; argv(): string[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-pw-recorder-'));
  dirs.push(cwd);
  const plan = join(cwd, 'plan.json');
  const argvPath = join(cwd, 'argv.json');
  writeFileSync(plan, JSON.stringify(run));
  const script = join(cwd, 'fake-playwright.mjs');
  writeFileSync(
    script,
    [
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `const plan = JSON.parse(readFileSync(${JSON.stringify(plan)}, 'utf8'));`,
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
      'const out = process.env.COVSEL_OUT;',
      'const workers = plan.workers ?? 1;',
      'const records = plan.records ?? [];',
      'for (let i = 0; i < records.length; i++) {',
      '  const file = join(out, `worker-${i % workers}.jsonl`);',
      '  appendFileSync(file, JSON.stringify(records[i]) + String.fromCharCode(10));',
      '}',
      'if (plan.raw !== undefined) appendFileSync(join(out, `worker-0.jsonl`), plan.raw);',
      'process.exit(plan.status ?? 0);',
    ].join('\n'),
  );
  return {
    cwd,
    command: [process.execPath, script],
    argv: () => JSON.parse(readFileSync(argvPath, 'utf8')) as string[],
  };
}

const recorderFor = (fake: { cwd: string; command: string[] }, observes = ['src/**']) =>
  createPlaywrightRecorder({
    command: fake.command,
    cwd: fake.cwd,
    config: resolveConfig({ observes }),
  });

const record = async (fake: ReturnType<typeof project>, files = ['e2e/a.spec.ts']) => {
  const recorder = recorderFor(fake);
  const units = await recorder.recordRun?.(files);
  return { recorder, units: units ?? [] };
};

describe('recording a Playwright run', () => {
  it('returns one unit per test the run reported', async () => {
    const fake = project({
      records: [
        {
          file: 'e2e/a.spec.ts',
          name: 'a.spec.ts adds an item',
          windows: [covering('src/cart.ts')],
          allowedUnmappable: [],
        },
        {
          file: 'e2e/a.spec.ts',
          name: 'a.spec.ts empties the cart',
          windows: [covering('src/empty.ts')],
          allowedUnmappable: [],
        },
      ],
    });

    const { units } = await record(fake);

    expect(units.map((u) => u.test)).toEqual([
      { file: 'e2e/a.spec.ts', name: 'a.spec.ts adds an item' },
      { file: 'e2e/a.spec.ts', name: 'a.spec.ts empties the cart' },
    ]);
    expect(units[0]?.files.map((f) => f.file)).toEqual(['src/cart.ts']);
    expect(units[1]?.files.map((f) => f.file)).toEqual(['src/empty.ts']);
  });

  it('collects what every worker wrote, not just one', async () => {
    // Playwright runs several workers at once and each holds its own file, so a
    // reader that took the first would silently drop most of the suite — and a
    // dropped test is one recording writes down as covering nothing.
    const fake = project({
      workers: 3,
      records: [1, 2, 3, 4, 5].map((n) => ({
        file: `e2e/${n}.spec.ts`,
        name: `${n}.spec.ts runs`,
        windows: [covering(`src/${n}.ts`)],
        allowedUnmappable: [],
      })),
    });

    const { units } = await record(fake, []);

    expect(units.map((u) => u.test.file).sort()).toEqual([
      'e2e/1.spec.ts',
      'e2e/2.spec.ts',
      'e2e/3.spec.ts',
      'e2e/4.spec.ts',
      'e2e/5.spec.ts',
    ]);
  });

  it('stamps each unit with the scope the recorder declares', async () => {
    const fake = project({
      records: [
        {
          file: 'e2e/a.spec.ts',
          name: 'a.spec.ts runs',
          windows: [covering('src/cart.ts')],
          allowedUnmappable: [],
        },
      ],
    });

    const { units } = await record(fake);

    // The unit says what watched it, which is what the map is stamped with —
    // and what makes every path outside fall open instead of reading as
    // uncovered.
    expect(units[0]?.observes).toEqual(['src/**']);
  });

  it('fails the recording when a window produced nothing usable', async () => {
    // Half a test's execution recorded as all of it is exactly the map that
    // skips tests: the regions the failed window would have covered read as
    // "ran nowhere".
    const fake = project({
      records: [
        {
          file: 'e2e/a.spec.ts',
          name: 'a.spec.ts runs',
          windows: [{ failed: 'the browser reported no JavaScript coverage' }],
          allowedUnmappable: [],
        },
      ],
    });

    await expect(record(fake)).rejects.toThrow(/reported no JavaScript coverage/);
  });

  it('fails the recording when the suite did not pass', async () => {
    // A test that failed partway executed part of what it covers, and nothing
    // afterwards can tell that entry apart from a complete one.
    const fake = project({
      status: 1,
      records: [
        {
          file: 'e2e/a.spec.ts',
          name: 'a.spec.ts runs',
          windows: [covering('src/cart.ts')],
          allowedUnmappable: [],
        },
      ],
    });

    await expect(record(fake)).rejects.toThrow(/playwright exited with 1/);
  });

  it('says how to install the fixture when the run reported nothing at all', async () => {
    // The likeliest reason, by far: the specs import Playwright's own `test`
    // rather than the extended one, so the fixture never ran. Without this the
    // symptom is a suite that passes and a map with no entries.
    const fake = project({ records: [] });

    await expect(record(fake)).rejects.toThrow(/covselFixtures/);
  });

  it('drops a half-written line rather than failing the read', async () => {
    // A worker killed mid-append leaves one. The test behind it is then a test
    // the run never reported, which recording refuses by name against the files
    // it asked about — a better failure than an unparseable byte.
    const fake = project({
      records: [
        {
          file: 'e2e/a.spec.ts',
          name: 'a.spec.ts runs',
          windows: [covering('src/cart.ts')],
          allowedUnmappable: [],
        },
      ],
      raw: '{"file":"e2e/b.spec.ts","na',
    });

    const { units } = await record(fake);

    expect(units.map((u) => u.test.name)).toEqual(['a.spec.ts runs']);
  });

  it('reports the scripts the run let through unmapped, once, and drains them', async () => {
    const fake = project({
      records: [
        {
          file: 'e2e/a.spec.ts',
          name: 'a.spec.ts runs',
          windows: [covering('src/cart.ts')],
          allowedUnmappable: ['https://cdn.example.com/widget.js'],
        },
        {
          file: 'e2e/a.spec.ts',
          name: 'a.spec.ts runs again',
          windows: [covering('src/cart.ts')],
          allowedUnmappable: ['https://cdn.example.com/widget.js'],
        },
      ],
    });

    const { recorder } = await record(fake);

    expect(recorder.unmappableAllowed?.()).toEqual(['https://cdn.example.com/widget.js']);
    // Drained, so a second recording does not report the first one's gaps.
    expect(recorder.unmappableAllowed?.()).toEqual([]);
  });

  it('runs the suite once, narrowed to the files covsel discovered', async () => {
    const fake = project({
      records: [
        {
          file: 'e2e/a.spec.ts',
          name: 'a.spec.ts runs',
          windows: [covering('src/cart.ts')],
          allowedUnmappable: [],
        },
      ],
    });

    await record(fake, ['e2e/a.spec.ts']);

    expect(fake.argv()).toEqual(['e2e/a.spec.ts']);
  });
});

describe('running a Playwright selection', () => {
  const spy = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-pw-selection-'));
    dirs.push(cwd);
    const calls = join(cwd, 'calls.jsonl');
    const script = join(cwd, 'spy.mjs');
    writeFileSync(
      script,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));`,
      ].join('\n'),
    );
    return {
      cwd,
      command: [process.execPath, script],
      calls: () =>
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as string[]),
    };
  };

  it('narrows a per-test selection with a grep pattern anchored at its end', () => {
    const s = spy();

    const code = playwrightAdapter.runSelection?.({
      selected: [{ file: 'e2e/cart.spec.ts', name: 'cart.spec.ts adds an item' }],
      command: s.command,
      cwd: s.cwd,
      stdio: 'ignore',
    });

    expect(code).toBe(0);
    const [file, flag, pattern] = s.calls()[0] ?? [];
    expect(file).toBe('e2e/cart.spec.ts');
    expect(flag).toBe('--grep');
    // Playwright matches this against `<project> <file> <describes> <title>`, so
    // a front anchor would name one browser and skip the rest.
    expect(new RegExp(pattern ?? '').test('chromium cart.spec.ts adds an item')).toBe(
      true,
    );
    expect(new RegExp(pattern ?? '').test('webkit cart.spec.ts adds an item')).toBe(true);
  });

  it('runs a whole-file selection plainly, with no pattern to narrow it', () => {
    const s = spy();

    playwrightAdapter.runSelection?.({
      selected: [{ file: 'e2e/admin.spec.ts' }],
      command: s.command,
      cwd: s.cwd,
      stdio: 'ignore',
    });

    expect(s.calls()).toEqual([['e2e/admin.spec.ts']]);
  });

  it('does not also narrow a file it is already running whole', () => {
    // A file selected both ways is selected whole: greping it to the named tests
    // would drop the ones the whole-file selection existed to run.
    const s = spy();

    playwrightAdapter.runSelection?.({
      selected: [
        { file: 'e2e/cart.spec.ts' },
        { file: 'e2e/cart.spec.ts', name: 'cart.spec.ts adds an item' },
      ],
      command: s.command,
      cwd: s.cwd,
      stdio: 'ignore',
    });

    expect(s.calls()).toEqual([['e2e/cart.spec.ts']]);
  });

  it('reports the worst exit code across both invocations', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-pw-exit-'));
    dirs.push(cwd);
    const script = join(cwd, 'fail.mjs');
    writeFileSync(script, 'process.exit(process.argv.includes("--grep") ? 3 : 0);');

    const code = playwrightAdapter.runSelection?.({
      selected: [
        { file: 'e2e/whole.spec.ts' },
        { file: 'e2e/named.spec.ts', name: 'named.spec.ts runs' },
      ],
      command: [process.execPath, script],
      cwd,
      stdio: 'ignore',
    });

    expect(code).toBe(3);
  });
});
