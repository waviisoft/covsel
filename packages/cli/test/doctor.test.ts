import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/index.js';

/**
 * `covsel doctor` compares covsel's idea of the suite against the runner's own.
 * The comparison is core's to be right about; what is checked here is the thing
 * a reader acts on -- that each direction is named with the repair it needs,
 * that a check nobody could run never reads as a clean bill of health, and that
 * the exit code says what the prose says.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A project whose adapter answers `listTests` with `collected`, or -- when that
 * is `undefined` -- does not implement it at all.
 */
function project(files: Record<string, string>, collected?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-doctor-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const pkg = join(dir, 'node_modules', '@covsel', 'adapter-generic');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: '@covsel/adapter-generic', type: 'module', main: 'index.js' })}\n`,
  );
  writeFileSync(
    join(pkg, 'index.js'),
    'export const adapter = {\n' +
      "  name: 'generic',\n" +
      '  formatSelection: (tests) => tests.map((t) => t.file),\n' +
      "  createRecorder: () => ({ observes: ['**'], record: async () => [] }),\n" +
      (collected === undefined
        ? ''
        : `  listTests: async () => ${JSON.stringify(collected)},\n`) +
      '};\n',
  );
  return dir;
}

/** Run `covsel doctor` in a throwaway project, capturing both streams. */
async function doctor(
  files: Record<string, string>,
  collected: string[] | undefined,
  argv: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = project(files, collected);
  let stdout = '';
  let stderr = '';
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk) => ((stdout += String(chunk)), true));
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk) => ((stderr += String(chunk)), true));
  const original = process.cwd();
  process.chdir(dir);
  try {
    const code = await main(['doctor', ...argv, '--', 'runner']);
    return { code, stdout, stderr };
  } finally {
    process.chdir(original);
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

const TEST = "test('t', () => {});\n";
const SUITE = {
  'covsel.json': JSON.stringify({ testGlobs: ['test/**/*.test.js'] }),
  'test/a.test.js': TEST,
  'test/b.test.js': TEST,
};

describe('the two configurations agreeing', () => {
  it('passes, and says what it compared', async () => {
    const { code, stdout } = await doctor(SUITE, ['test/a.test.js', 'test/b.test.js']);
    expect(code).toBe(0);
    expect(stdout).toContain('2');
    expect(stdout).toMatch(/agree/i);
  });
});

describe('a file the runner collects and covsel does not discover', () => {
  it('fails, and says the test can never be selected', async () => {
    const { code, stdout } = await doctor(SUITE, [
      'test/a.test.js',
      'test/b.test.js',
      'benchmarks/c.test.js',
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain('benchmarks/c.test.js');
    expect(stdout).toMatch(/never be selected|no change can select/i);
  });

  it('names testGlobs, since that is the field that fixes it', async () => {
    const { code, stdout } = await doctor(SUITE, ['test/a.test.js', 'other/c.test.js']);
    expect(code).toBe(1);
    expect(stdout).toContain('testGlobs');
  });
});

describe('a file covsel discovers and the runner does not collect', () => {
  it('fails, and names testIgnore rather than testGlobs', async () => {
    const { code, stdout } = await doctor(SUITE, ['test/a.test.js']);
    expect(code).toBe(1);
    expect(stdout).toContain('test/b.test.js');
    expect(stdout).toContain('testIgnore');
  });
});

describe('a runner that collected nothing', () => {
  it('is a failure, not an agreement', async () => {
    // The way a set comparison passes loudest when it is least true: both sides
    // empty, or the runner's side empty against a suite that exists. Neither is
    // evidence that two configurations agree.
    const { code, stdout } = await doctor(SUITE, []);
    expect(code).toBe(1);
    expect(stdout).not.toMatch(/agree/i);
  });
});

describe('an adapter that cannot ask its runner', () => {
  it('says the check did not run, rather than reporting agreement', async () => {
    // `node --test` has no listing mode and the generic wrap cannot know what an
    // arbitrary command collects. Printing "no drift" there would be a green
    // check that never looked at anything.
    const { code, stdout, stderr } = await doctor(SUITE, undefined);
    expect(code).toBe(0);
    expect(`${stdout}${stderr}`).not.toMatch(/agree/i);
    expect(`${stdout}${stderr}`).toMatch(/cannot|unavailable|does not support/i);
  });

  it('fails under --require, for a pipeline that wants the check or nothing', async () => {
    const { code } = await doctor(SUITE, undefined, ['--require']);
    expect(code).toBe(1);
  });
});

describe('an adapter whose listing failed', () => {
  it('reports the reason rather than a stack trace, and does not call it agreement', async () => {
    const dir = project(SUITE, []);
    const pkg = join(dir, 'node_modules', '@covsel', 'adapter-generic', 'index.js');
    writeFileSync(
      pkg,
      'export const adapter = {\n' +
        "  name: 'generic',\n" +
        '  formatSelection: (tests) => tests.map((t) => t.file),\n' +
        "  createRecorder: () => ({ observes: ['**'], record: async () => [] }),\n" +
        "  listTests: async () => { throw new Error('the runner printed no JSON'); },\n" +
        '};\n',
    );
    let stdout = '';
    let stderr = '';
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => ((stdout += String(chunk)), true));
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => ((stderr += String(chunk)), true));
    const original = process.cwd();
    process.chdir(dir);
    try {
      const code = await main(['doctor', '--', 'runner']);
      expect(code).toBe(1);
      expect(`${stdout}${stderr}`).toContain('the runner printed no JSON');
      expect(`${stdout}${stderr}`).not.toMatch(/agree/i);
    } finally {
      process.chdir(original);
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('--format json', () => {
  it('puts both directions on stdout for a script to branch on', async () => {
    const { code, stdout } = await doctor(
      SUITE,
      ['test/a.test.js', 'extra.test.js'],
      ['--format', 'json'],
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.unselectable).toEqual(['extra.test.js']);
    expect(parsed.unrecordable).toEqual(['test/b.test.js']);
    expect(parsed.discoveredCount).toBe(2);
    expect(parsed.collectedCount).toBe(2);
  });

  it('says the check was unavailable rather than reporting empty drift', async () => {
    // The JSON equivalent of the green-check-that-never-looked: two empty lists
    // are what agreement looks like, so the unavailable case must be a different
    // shape and not merely a different exit code.
    const { stdout } = await doctor(SUITE, undefined, ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.available).toBe(false);
    expect(parsed.unselectable).toBeUndefined();
  });
});

describe('the command', () => {
  it('asks for a runner command rather than guessing one', async () => {
    const dir = project(SUITE, []);
    let stderr = '';
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => ((stderr += String(chunk)), true));
    const original = process.cwd();
    process.chdir(dir);
    try {
      expect(await main(['doctor'])).toBe(1);
      expect(stderr).toContain('--');
    } finally {
      process.chdir(original);
      errSpy.mockRestore();
    }
  });
});
