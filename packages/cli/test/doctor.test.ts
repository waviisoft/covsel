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
    expect(stdout).toContain('covsel discovers 2 test file(s)');
    expect(stdout).toContain('collects  2 test file(s)');
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

  it('names testGlobs and not testIgnore, since only one of them fixes it', async () => {
    // Both directions at once would satisfy an assertion for either field, so
    // this fixture drifts in one direction only: the runner collects everything
    // covsel does, plus one more.
    const { code, stdout } = await doctor(SUITE, [
      'test/a.test.js',
      'test/b.test.js',
      'other/c.test.js',
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain('testGlobs');
    expect(stdout).not.toContain('testIgnore');
  });
});

describe('a file in a directory covsel never walks', () => {
  it('is not repaired by widening testGlobs, and says so', async () => {
    // `dist/`, `node_modules/`, `coverage/` and `.covsel/` are excluded from
    // discovery at any depth with no config knob, so "widen testGlobs" is advice
    // that cannot work -- on a report someone is reading because something is
    // already not working.
    const { code, stdout } = await doctor(SUITE, [
      'test/a.test.js',
      'test/b.test.js',
      'dist/test/a.test.js',
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain('dist/test/a.test.js');
    expect(stdout).toMatch(/never walks/i);
  });

  it('says nothing about exclusions when none of the drift is excluded', async () => {
    const { stdout } = await doctor(SUITE, [
      'test/a.test.js',
      'test/b.test.js',
      'other/c.test.js',
    ]);
    expect(stdout).not.toMatch(/never walks/i);
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
    const { code, stdout } = await doctor(SUITE, []);
    expect(code).toBe(1);
    expect(stdout).not.toMatch(/agree/i);
  });

  it('is a failure even when covsel discovered nothing either', async () => {
    // The way a set comparison passes loudest when it is least true: nothing
    // compared against nothing is not evidence that two configurations agree.
    // The test above does not reach this -- with files on disk, an empty listing
    // still exits 1 through the ordinary drift path, so it passes against an
    // implementation with the empty-listing guard deleted. This one does not.
    const { code, stdout } = await doctor(
      { 'covsel.json': JSON.stringify({ testGlobs: ['test/**/*.test.js'] }) },
      [],
    );
    expect(code).toBe(1);
    expect(stdout).not.toMatch(/agree/i);
  });
});

describe('a command that narrows what the runner collects', () => {
  it('is what the report warns about, since no syntax check catches every one', async () => {
    // No syntax check catches every narrowing command -- `--project`, or a bare
    // word after a value-taking flag -- so the direction that could be read as
    // "hide these files" has to carry the warning in prose.
    const { code, stdout } = await doctor(SUITE, ['test/a.test.js']);
    expect(code).toBe(1);
    expect(stdout).toMatch(/whole suite/i);
    expect(stdout).toContain('--project');
  });

  it('names the command it asked with, so the reader can check it', async () => {
    const { stdout } = await doctor(SUITE, ['test/a.test.js']);
    expect(stdout).toContain('asked:');
    expect(stdout).toContain('runner');
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
    // are what agreement looks like, so `available` is what tells them apart.
    const { stdout } = await doctor(SUITE, undefined, ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.available).toBe(false);
    expect(parsed.ok).toBe(true);
  });

  it('keeps the same shape when the listing failed, so a script can still read it', async () => {
    // `covsel fetch` emits its object on the failing path too. A caller reading
    // `.unselectable.length` must not throw on exactly the states that mean the
    // question was never answered.
    const dir = project(SUITE, []);
    writeFileSync(
      join(dir, 'node_modules', '@covsel', 'adapter-generic', 'index.js'),
      'export const adapter = {\n' +
        "  name: 'generic',\n" +
        '  formatSelection: (tests) => tests.map((t) => t.file),\n' +
        "  createRecorder: () => ({ observes: ['**'], record: async () => [] }),\n" +
        "  listTests: async () => { throw new Error('narrows the run'); },\n" +
        '};\n',
    );
    let stdout = '';
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => ((stdout += String(chunk)), true));
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const original = process.cwd();
    process.chdir(dir);
    try {
      expect(await main(['doctor', '--format', 'json', '--', 'runner'])).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.available).toBe(false);
      expect(parsed.reason).toContain('narrows the run');
      expect(parsed.unselectable).toEqual([]);
      expect(parsed.unrecordable).toEqual([]);
    } finally {
      process.chdir(original);
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('reports ok:false for an empty listing, which is not two lists that match', async () => {
    const { stdout } = await doctor(SUITE, [], ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.available).toBe(false);
    expect(parsed.collectedCount).toBe(0);
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
      expect(stderr).toContain('expected a runner command after `--`');
    } finally {
      process.chdir(original);
      errSpy.mockRestore();
    }
  });
});
