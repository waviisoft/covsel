import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MAP_SCHEMA_VERSION, publishMap } from '@covsel/core';
import { main } from '../src/index.js';

/**
 * `--format json` is the surface a CI integration reads covsel through, so what
 * is checked here is the contract that makes one possible: the object lands on
 * stdout alone, the human report keeps its stream, and neither the answer nor
 * the exit code changes with the format.
 *
 * The selection itself is core's to be right about (see `@covsel/core`'s
 * selection tests). These fixtures only need selection to *happen*, which takes
 * a real work tree and a map anchored to its commit.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Run `fn` with the process cwd pointed at a throwaway project. */
async function inProject<T>(
  files: Record<string, string>,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-json-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const abs = join(dir, name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(original);
  }
}

/**
 * Run git in `cwd`. The developer's own configuration is pinned out so a local
 * `init.defaultBranch`, hooks, or signing settings cannot change what these
 * tests measure.
 */
function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** Initialise a repository in `cwd`, commit everything in it, and return HEAD. */
function commitAll(cwd: string): string {
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'covsel test']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'fixture']);
  return git(cwd, ['rev-parse', 'HEAD']);
}

async function capture(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const code = await fn();
  const text = (spy: typeof outSpy) => spy.mock.calls.map((c) => String(c[0])).join('');
  const result = { code, out: text(outSpy), err: text(errSpy) };
  outSpy.mockRestore();
  errSpy.mockRestore();
  return result;
}

/**
 * Parse stdout as the one object it is supposed to be. Asserting the single line
 * here rather than in each test is what keeps "machine-readable" from quietly
 * becoming "machine-readable if you strip the other lines first".
 */
function parseOne(out: string): Record<string, unknown> {
  const lines = out.split('\n').filter((l) => l !== '');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

const pkg = `${JSON.stringify({ name: 'fixture', private: true })}\n`;

/**
 * Install an adapter into the project. Adapter resolution is anchored to the
 * project's own `node_modules`, so a fixture without one cannot get as far as a
 * selection — and this one renders a named unit the way a per-test runner would,
 * which is what makes `files` and `tests` different lists rather than two names
 * for the same one.
 */
function stubAdapter(cwd: string): void {
  const dir = join(cwd, 'node_modules', '@covsel', 'adapter-generic');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({
      name: '@covsel/adapter-generic',
      type: 'module',
      main: 'index.js',
    })}\n`,
  );
  writeFileSync(
    join(dir, 'index.js'),
    'export const adapter = {\n' +
      "  name: 'generic',\n" +
      '  formatSelection: (tests) =>\n' +
      '    tests.map((t) => (t.name === undefined ? t.file : `${t.file} -t ${t.name}`)),\n' +
      "  createRecorder: () => ({ observes: ['**'], record: async () => [] }),\n" +
      '};\n',
  );
}

const RECORDED_AT = '2026-07-01T00:00:00.000Z';

/**
 * Put a map for `commit` in the project's archive, through the same publish the
 * CI recipe uses. Naming an archived map is the archive's business — hand-built
 * names would pass this test while a real `covsel publish` produced something
 * `fetch` skips.
 */
function archive(cwd: string, commit: string): void {
  const result = publishMap({
    dir: join(cwd, '.covsel', 'archive'),
    map: {
      schemaVersion: MAP_SCHEMA_VERSION,
      granularity: 'file',
      recordedAt: RECORDED_AT,
      commit,
      sentinelHashes: {},
      observed: ['**'],
      entries: [],
    },
  });
  if (!result.ok) throw new Error(`fixture could not be published: ${result.reason}`);
}

/** Write a map into a project's store. */
function writeMap(cwd: string, fields: Record<string, unknown>): void {
  mkdirSync(join(cwd, '.covsel'), { recursive: true });
  writeFileSync(
    join(cwd, '.covsel', 'map.json'),
    JSON.stringify({
      schemaVersion: MAP_SCHEMA_VERSION,
      granularity: 'file',
      recordedAt: '2026-07-01T00:00:00.000Z',
      sentinelHashes: {},
      observed: ['**'],
      entries: [],
      ...fields,
    }),
  );
}

/**
 * A project where selection narrows: two test files, one map entry each, and an
 * uncommitted edit to the source only one of them covers.
 */
async function inSelectingProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  return inProject(
    {
      'package.json': pkg,
      'src/math.js': 'export const add = (a, b) => a + b;\n',
      'src/other.js': 'export const other = () => 2;\n',
      'math.test.js': '',
      'other.test.js': '',
    },
    async (cwd) => {
      stubAdapter(cwd);
      const commit = commitAll(cwd);
      writeMap(cwd, {
        commit,
        entries: [
          {
            test: { file: 'math.test.js', name: 'adds' },
            files: [{ file: 'src/math.js', fileHash: 'sha256:math' }],
          },
          {
            test: { file: 'other.test.js' },
            files: [{ file: 'src/other.js', fileHash: 'sha256:other' }],
          },
        ],
      });
      writeFileSync(join(cwd, 'src/math.js'), 'export const add = (a, b) => b + a;\n');
      return fn(cwd);
    },
  );
}

describe('covsel affected --format json', () => {
  it('puts one object on stdout and leaves the reason lines on stderr', async () => {
    // A full run is the case with something to say on both streams at once, so
    // it is the one that proves they stay separate.
    const { code, out, err } = await inProject({ 'package.json': pkg }, (cwd) => {
      stubAdapter(cwd);
      return capture(() => main(['affected', '--format', 'json']));
    });

    expect(code).toBe(0);
    const report = parseOne(out);
    expect(report['fullRun']).toBe(true);
    expect(err).toContain('covsel: full run');
  });

  it('names why a full run is a full run, rather than implying every file was chosen', async () => {
    const { out } = await inProject({ 'package.json': pkg }, (cwd) => {
      stubAdapter(cwd);
      return capture(() => main(['affected', '--format', 'json']));
    });

    const report = parseOne(out);
    expect(report['fullRun']).toBe(true);
    expect(typeof report['reason']).toBe('string');
  });

  it('carries the selection, the discovered count, and the verdict', async () => {
    const { code, out } = await inSelectingProject(() =>
      capture(() => main(['affected', '--format', 'json'])),
    );

    expect(code).toBe(0);
    const report = parseOne(out);
    expect(report['fullRun']).toBe(false);
    // The runner-native rendering and the plain test files behind it. A caller
    // sharding the suite needs the second; one appending to a command line needs
    // the first; per-test selection is where they stop being the same list.
    expect(report['files']).toEqual(['math.test.js -t adds']);
    expect(report['tests']).toEqual(['math.test.js']);
    expect(report['selected']).toEqual([{ file: 'math.test.js', name: 'adds' }]);
    // The denominator of "1 of 2", which is the whole point of reporting a
    // selection to CI: a narrow selection and a broken glob look alike without it.
    expect(report['discovered']).toBe(2);
  });

  it('prints the same file list the human format does', async () => {
    const { files, json } = await inSelectingProject(async () => {
      const human = await capture(() => main(['affected']));
      const machine = await capture(() => main(['affected', '--format', 'json']));
      return { files: human.out, json: machine.out };
    });

    const report = parseOne(json);
    expect(report['files']).toEqual(files.split('\n').filter((l) => l !== ''));
  });

  it('exits the same way with and without the flag', async () => {
    const codes = await inSelectingProject(async () => {
      const human = await capture(() => main(['affected']));
      const machine = await capture(() => main(['affected', '--format', 'json']));
      return [human.code, machine.code];
    });

    expect(codes[0]).toBe(codes[1]);
  });
});

describe('covsel status --format json', () => {
  it('carries what the report says, as data', async () => {
    const { code, out } = await inSelectingProject(async (cwd) => {
      const captured = await capture(() => main(['status', '--format', 'json']));
      return { ...captured, commit: git(cwd, ['rev-parse', 'HEAD']) };
    });

    expect(code).toBe(0);
    const report = parseOne(out);
    expect(report['mapState']).toBe('usable');
    expect(typeof report['mapPath']).toBe('string');
    expect(typeof report['commit']).toBe('string');
    expect(typeof report['ageMs']).toBe('number');
    expect(report['granularity']).toBe('file');
    expect(report['entryCount']).toBe(2);
    expect(report['discoveredTestCount']).toBe(2);
    expect(report['nextIsFullRun']).toBe(false);
  });

  it('reports the commit the map records, which is what selection measures from', async () => {
    const { out, commit } = await inSelectingProject(async (cwd) => {
      const captured = await capture(() => main(['status', '--format', 'json']));
      return { ...captured, commit: git(cwd, ['rev-parse', 'HEAD']) };
    });

    expect(parseOne(out)['commit']).toBe(commit);
  });

  it('tells a map it cannot use apart from one that is not there', async () => {
    const unusable = await inProject({ 'package.json': pkg }, async (cwd) => {
      writeMap(cwd, { schemaVersion: MAP_SCHEMA_VERSION - 1 });
      return capture(() => main(['status', '--format', 'json']));
    });
    const absent = await inProject({ 'package.json': pkg }, () =>
      capture(() => main(['status', '--format', 'json'])),
    );

    const rejected = parseOne(unusable.out);
    expect(rejected['mapState']).toBe('unusable');
    expect(typeof rejected['unusableReason']).toBe('string');
    expect(parseOne(absent.out)['mapState']).toBe('absent');
  });

  it('describes nothing it could not read', async () => {
    const { out } = await inProject({ 'package.json': pkg }, async (cwd) => {
      mkdirSync(join(cwd, '.covsel'), { recursive: true });
      writeFileSync(join(cwd, '.covsel', 'map.json'), '{ "schemaVersion": ');
      return capture(() => main(['status', '--format', 'json']));
    });

    const report = parseOne(out);
    expect(report['mapState']).toBe('unusable');
    // The counts below the header describe a map that parsed. Reporting them as
    // absent keys is the difference between "covsel could not read it" and
    // "the map is empty", and only one of those is true.
    expect(report).not.toHaveProperty('entryCount');
    expect(report).not.toHaveProperty('granularity');
  });

  it('prints no human report beside the object', async () => {
    const { out } = await inSelectingProject(() =>
      capture(() => main(['status', '--format', 'json'])),
    );

    expect(out).not.toContain('map:  ');
    expect(out).not.toContain('next:');
  });

  it('exits the same way with and without the flag', async () => {
    const codes = await inSelectingProject(async () => {
      const human = await capture(() => main(['status']));
      const machine = await capture(() => main(['status', '--format', 'json']));
      return [human.code, machine.code];
    });

    expect(codes[0]).toBe(codes[1]);
  });
});

describe('covsel fetch --format json', () => {
  it('says which map it installed and how it was chosen', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg, 'a.test.js': '' },
      async (cwd) => {
        archive(cwd, commitAll(cwd));
        return capture(() => main(['fetch', '--format', 'json']));
      },
    );

    expect(code).toBe(0);
    const report = parseOne(out);
    expect(report['ok']).toBe(true);
    expect(report['how']).toBe('ancestor');
    expect(typeof report['commit']).toBe('string');
    expect(typeof report['mapPath']).toBe('string');
    expect(report['recordedAt']).toBe(RECORDED_AT);
  });

  it('carries every candidate it passed over, with the reason', async () => {
    const missing = 'f'.repeat(40);
    const { out } = await inProject(
      { 'package.json': pkg, 'a.test.js': '' },
      async (cwd) => {
        commitAll(cwd);
        // A commit this checkout has never heard of: the shallow-clone case, and
        // the one a CI job needs to see the reason for.
        archive(cwd, missing);
        return capture(() => main(['fetch', '--format', 'json']));
      },
    );

    const report = parseOne(out);
    expect(report['ok']).toBe(false);
    const skipped = report['skipped'] as { commit: string; reason: string }[];
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.commit).toBe(missing);
    expect(typeof skipped[0]?.reason).toBe('string');
  });

  it('reports finding nothing without failing, since the tests still run', async () => {
    const { code, out } = await inProject({ 'package.json': pkg }, () =>
      capture(() => main(['fetch', '--format', 'json'])),
    );

    expect(code).toBe(0);
    const report = parseOne(out);
    expect(report['ok']).toBe(false);
    expect(typeof report['reason']).toBe('string');
  });

  it('still fails with --require, and still says why on stdout', async () => {
    const { code, out } = await inProject({ 'package.json': pkg }, () =>
      capture(() => main(['fetch', '--format', 'json', '--require'])),
    );

    expect(code).toBe(1);
    expect(parseOne(out)['ok']).toBe(false);
  });
});

describe('--format', () => {
  it.each([
    ['affected', 'files'],
    ['status', 'text'],
    ['fetch', 'text'],
  ])('%s rejects a format it cannot print', async (cmd, human) => {
    const { code, err } = await inProject({ 'package.json': pkg }, () =>
      capture(() => main([cmd, '--format', 'yaml'])),
    );

    expect(code).toBe(1);
    expect(err).toContain(`covsel ${cmd}:`);
    expect(err).toContain("unsupported --format 'yaml'");
    expect(err).toContain(human);
  });

  it.each(['status', 'fetch'])('%s prints its human report by default', async (cmd) => {
    const { out, err } = await inProject({ 'package.json': pkg }, () =>
      capture(() => main([cmd])),
    );

    expect(`${out}${err}`).not.toContain('{"');
  });
});
