import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { MAP_SCHEMA_VERSION } from '@covsel/core';
import { VERSION, main } from '../src/index.js';

/** What the stubbed prompt answers; set by `answering`. */
let readlineAnswer = '';

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: () => Promise.resolve(readlineAnswer),
    close: () => {},
  }),
}));

const dirs: string[] = [];

/** Run `fn` with the process cwd pointed at a throwaway project. */
async function inProject<T>(
  files: Record<string, string>,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-cli-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(original);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Whether an archive holds a map for a commit. Archived names carry the recorded
 * instant as well as the commit, so the commit is a suffix rather than the name.
 */
function archivedUnder(dir: string, commit: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((n) => n.endsWith(`-${commit}.json`));
}

/** Write a map into a project's store, with only the fields a test cares about. */
function writeMap(cwd: string, fields: { commit?: string; recordedAt: string }): void {
  mkdirSync(join(cwd, '.covsel'), { recursive: true });
  writeFileSync(
    join(cwd, '.covsel', 'map.json'),
    JSON.stringify({
      schemaVersion: MAP_SCHEMA_VERSION,
      granularity: 'file',
      ...fields,
      sentinelHashes: {},
      observed: ['**'],
      entries: [],
    }),
  );
}

async function captureStdout(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string }> {
  const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const code = await fn();
  const out = spy.mock.calls.map((c) => String(c[0])).join('');
  spy.mockRestore();
  return { code, out };
}

async function captureStderr(
  fn: () => Promise<number>,
): Promise<{ code: number; err: string }> {
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const code = await fn();
  const err = spy.mock.calls.map((c) => String(c[0])).join('');
  spy.mockRestore();
  return { code, err };
}

describe('covsel cli', () => {
  it('prints help and exits 0 with no args', async () => {
    const { code, out } = await captureStdout(() => main([]));
    expect(code).toBe(0);
    expect(out).toContain('covsel -- runtime-coverage');
  });

  it.each(['-h', '--help'])('prints help for %s', async (flag) => {
    const { code, out } = await captureStdout(() => main([flag]));
    expect(code).toBe(0);
    expect(out).toContain('Usage:');
  });

  it('help surfaces the fail-open guarantee and current schema version', async () => {
    const { out } = await captureStdout(() => main(['--help']));
    expect(out).toContain('fail-open');
    expect(out).toContain(`Map schema v${MAP_SCHEMA_VERSION}`);
  });

  it('help lists the available commands', async () => {
    const { out } = await captureStdout(() => main(['--help']));
    for (const cmd of ['record', 'affected', 'run', 'watch', 'status', 'explain']) {
      expect(out).toContain(`covsel ${cmd}`);
    }
  });

  it('help documents the watch options', async () => {
    const { out } = await captureStdout(() => main(['--help']));
    for (const opt of ['--debounce', '--record', '--no-initial-run']) {
      expect(out).toContain(opt);
    }
  });

  it('help documents the archive commands and their options', async () => {
    const { out } = await captureStdout(() => main(['--help']));
    for (const cmd of ['publish', 'fetch']) expect(out).toContain(`covsel ${cmd}`);
    for (const opt of ['--archive', '--keep', '--require', '--force']) {
      expect(out).toContain(opt);
    }
  });

  it.each(['-v', '--version'])('prints the version for %s', async (flag) => {
    const { code, out } = await captureStdout(() => main([flag]));
    expect(code).toBe(0);
    expect(out.trim()).toBe(VERSION);
  });

  it('rejects an unknown command (exit 1)', async () => {
    const { code, err } = await captureStderr(() => main(['frobnicate']));
    expect(code).toBe(1);
    expect(err).toContain("unknown command 'frobnicate'");
  });

  it('record without a command after -- errors', async () => {
    const { code, err } = await captureStderr(() => main(['record']));
    expect(code).toBe(1);
    expect(err).toContain('expected a runner command after');
  });

  it('watch without a command after -- errors', async () => {
    const { code, err } = await captureStderr(() => main(['watch']));
    expect(code).toBe(1);
    expect(err).toContain('expected a runner command after');
  });

  it.each(['-5', 'soon'])('watch rejects a bad --debounce (%s)', async (value) => {
    const { code, err } = await captureStderr(() =>
      main(['watch', '--debounce', value, '--', 'node', '--test']),
    );
    expect(code).toBe(1);
    expect(err).toContain('--debounce needs a non-negative number');
  });

  it('merge without any shard files errors', async () => {
    const { code, err } = await captureStderr(() => main(['merge']));
    expect(code).toBe(1);
    expect(err).toContain('expected shard map files');
  });

  it('merge rejects --out without a path rather than writing somewhere unexpected', async () => {
    const { code, err } = await captureStderr(() => main(['merge', 'a.json', '--out']));
    expect(code).toBe(1);
    expect(err).toContain('--out needs a file path');
  });

  it('merge reports an unreadable shard instead of silently dropping it', async () => {
    const { code, err } = await captureStderr(() =>
      main(['merge', 'definitely-missing-map.json']),
    );
    expect(code).toBe(1);
    expect(err).toContain('cannot read');
  });

  it.each(['record', 'affected', 'run', 'watch'])(
    '%s rejects an adapter that is not installed, and says how to install it',
    async (cmd) => {
      const argv = cmd === 'affected' ? [cmd] : [cmd, '--', 'node', '--test'];
      const { code, err } = await captureStderr(() =>
        main([...argv.slice(0, 1), '--adapter', 'frobnicate', ...argv.slice(1)]),
      );
      expect(code).toBe(1);
      expect(err).toContain(`covsel ${cmd}:`);
      expect(err).toContain("adapter 'frobnicate' is not installed");
      expect(err).toContain('npm install --save-dev @covsel/adapter-frobnicate');
    },
  );

  it.each(['status', 'affected'])(
    '%s refuses to run under a granularity covsel does not implement',
    async (cmd) => {
      // The command has to stop here rather than resolve the value to something
      // covsel can do: recording at a granularity the project did not name is
      // invisible from the outside, and so is ignoring the one it did.
      await inProject(
        { 'covsel.json': `${JSON.stringify({ granularity: 'line' })}\n` },
        async () => {
          await expect(main([cmd])).rejects.toThrow(
            /granularity "line" is not supported/,
          );
          await expect(main([cmd])).rejects.toThrow(/file, block/);
        },
      );
    },
  );

  it('explain refuses to run under a granularity covsel does not implement', async () => {
    // Read-only is not a reason to answer under a configuration covsel cannot
    // record at: what the map means depends on it, and explaining a file is
    // saying what that map means.
    await inProject(
      { 'covsel.json': `${JSON.stringify({ granularity: 'line' })}\n` },
      async () => {
        await expect(main(['explain', 'covsel.json'])).rejects.toThrow(
          /granularity "line" is not supported/,
        );
      },
    );
  });

  it('affected rejects an unsupported --format', async () => {
    const { code, err } = await captureStderr(() =>
      main(['affected', '--format', 'vitest']),
    );
    expect(code).toBe(1);
    expect(err).toContain("unsupported --format 'vitest'");
  });

  it('help lists init', async () => {
    const { out } = await captureStdout(() => main(['--help']));
    expect(out).toContain('covsel init');
  });
});

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

const pkg = (fields: Record<string, unknown>) =>
  `${JSON.stringify({ name: 'fixture', private: true, ...fields })}\n`;

/**
 * Put a fake package manager first on PATH, so an install is observable without
 * reaching the network. Returns the file it logs its arguments to. `failsFor`
 * rejects only the installs whose arguments contain that string, which is how a
 * registry answers for a package published under one specifier and not another.
 */
function stubPackageManager(
  cwd: string,
  name: string,
  exitCode = 0,
  failsFor?: string,
  killedFor?: string,
): string {
  const bin = join(cwd, 'stub-bin');
  const log = join(cwd, 'install.log');
  mkdirSync(bin, { recursive: true });
  // The needle is quoted inside the glob, so a pattern carrying `*`, `?` or `[`
  // matches literally rather than silently widening.
  const reject =
    failsFor === undefined ? '' : `case "$*" in *"${failsFor}"*) exit 1 ;; esac\n`;
  // What Ctrl-C during an install looks like to spawnSync: no exit status, a
  // signal instead.
  const killed =
    killedFor === undefined
      ? ''
      : `case "$*" in *"${killedFor}"*) kill -TERM $$ ;; esac\n`;
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\necho "$@" >> ${log}\n${reject}${killed}exit ${exitCode}\n`,
  );
  chmodSync(join(bin, name), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
  return log;
}

/**
 * Install a working adapter into the project under a package name of its own.
 * A community adapter is a package like any other, and only an installed one
 * tells "covsel has not heard of this name" apart from "nothing provides it".
 */
function stubAdapterPackage(cwd: string, packageName: string, name: string): void {
  const dir = join(cwd, 'node_modules', packageName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: packageName, type: 'module', main: 'index.js' })}\n`,
  );
  writeFileSync(
    join(dir, 'index.js'),
    'export const adapter = {\n' +
      `  name: ${JSON.stringify(name)},\n` +
      '  formatSelection: (tests) => tests.map((t) => t.file),\n' +
      "  createRecorder: () => ({ observes: ['**'], record: async () => [] }),\n" +
      '};\n',
  );
}

describe('covsel init', () => {
  it('names the adapter, writes the config, and prints the next steps', async () => {
    const result = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        // `--no-install` means nothing should reach a package manager. Stubbed
        // anyway, so a regression that starts installing fails here instead of
        // quietly reaching the network.
        stubPackageManager(cwd, 'npm');
        const captured = await capture(() =>
          main(['init', '--no-install', '--auto-approve']),
        );
        return { ...captured, config: readFileSync(join(cwd, 'covsel.json'), 'utf8') };
      },
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain('run only the tests your changes can affect');
    expect(result.out).toContain('detected vitest');
    expect(result.out).toContain('vitest is a dependency');
    expect(result.out).toContain('adapter: vitest');
    expect(result.out).toContain('covsel record --adapter vitest');
    expect(JSON.parse(result.config)).toEqual({ adapter: 'vitest' });
  });

  // Every workspace adapter resolves in-process here (vitest aliases them to
  // source), so a name nothing provides is what exercises the uninstalled path.
  it('installs the adapter with the project package manager', async () => {
    const { out, installed } = await inProject(
      {
        'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
        'pnpm-lock.yaml': '',
      },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'pnpm');
        const captured = await capture(() =>
          main(['init', '--adapter', 'not-a-real-runner', '--auto-approve']),
        );
        return { ...captured, installed: readFileSync(log, 'utf8').trim() };
      },
    );

    expect(out).toContain('  install  @covsel/adapter-not-a-real-runner');
    expect(installed).toBe('add --save-dev @covsel/adapter-not-a-real-runner');
  });

  it('installs what the runner needs beyond the adapter', async () => {
    const { installed } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'npm');
        await capture(() => main(['init', '--auto-approve']));
        return { installed: readFileSync(log, 'utf8').trim() };
      },
    );

    // The Vitest adapter records through Vitest's own coverage provider, so
    // installing the adapter alone would leave recording broken.
    expect(installed).toContain('@vitest/coverage-v8');
  });

  it('plans no install under --no-install', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      () => capture(() => main(['init', '--no-install', '--auto-approve'])),
    );

    // No install line in the plan — but the packages are still named, under
    // `skip`, because agreeing to this plan means agreeing to install them.
    expect(code).toBe(0);
    expect(out).not.toContain('  install  ');
    expect(out).toContain('  skip     installing');
  });

  it('reports a project that is already set up without redoing it', async () => {
    const { code, out } = await inProject(
      {
        'package.json': pkg({ devDependencies: { jest: '^29.0.0' } }),
        'covsel.json': `${JSON.stringify({ adapter: 'jest' })}\n`,
        '.gitignore': '.covsel/\n',
      },
      async (cwd) => {
        stubPackageManager(cwd, 'npm');
        return capture(() => main(['init']));
      },
    );

    expect(code).toBe(0);
    expect(out).toContain('already set up');
    expect(out).toContain('covsel record --adapter jest');
    // A repeat run has nothing to explain and should stay quiet.
    expect(out).not.toContain('run only the tests your changes can affect');
  });

  it('exits non-zero and points at an adapter request when nothing is detected', async () => {
    const { code, err } = await inProject(
      { 'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }) },
      () => capture(() => main(['init'])),
    );

    expect(code).toBe(1);
    expect(err).toContain('no test runner detected');
    expect(err).toContain('adapter_request.yml');
    expect(err).toContain('covsel init --adapter');
    expect(err).toContain(`covsel:          ${VERSION}`);
  });

  it('leaves the project untouched when it cannot name an adapter', async () => {
    const files = await inProject(
      { 'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }) },
      async (cwd) => {
        await capture(() => main(['init']));
        return {
          config: existsSync(join(cwd, 'covsel.json')),
          gitignore: existsSync(join(cwd, '.gitignore')),
        };
      },
    );

    expect(files).toEqual({ config: false, gitignore: false });
  });

  it('exits non-zero for a runner no adapter records', async () => {
    const { code, err } = await inProject(
      { 'package.json': pkg({ devDependencies: { cypress: '^15.0.0' } }) },
      () => capture(() => main(['init'])),
    );

    expect(code).toBe(1);
    expect(err).toContain('no adapter records cypress yet');
    expect(err).toContain('Keep running that suite in full');
  });
});

/**
 * Whether a name has a package behind it is the registry's answer, not covsel's,
 * so the install is the check — and it has to run before anything is written, or
 * a name nothing provides leaves a project configured for an adapter that does
 * not exist and every later command fails on it. Every test here stubs the
 * package manager: one that reached a real registry would be asking the network
 * what these tests assert.
 */
describe('covsel init — the package manager decides whether a name is real', () => {
  it('installs an adapter published only under the community prefix', async () => {
    const { code, config, installed } = await inProject(
      { 'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }) },
      async (cwd) => {
        // Nothing is published as @covsel/adapter-ava; covsel-adapter-ava is.
        const log = stubPackageManager(cwd, 'npm', 0, '@covsel/adapter-ava');
        const captured = await capture(() =>
          main(['init', '--adapter', 'ava', '--auto-approve']),
        );
        return {
          ...captured,
          config: readFileSync(join(cwd, 'covsel.json'), 'utf8'),
          installed: readFileSync(log, 'utf8'),
        };
      },
    );

    expect(code).toBe(0);
    expect(installed).toContain('@covsel/adapter-ava');
    expect(installed).toContain('covsel-adapter-ava');
    expect(JSON.parse(config)).toEqual({ adapter: 'ava' });
  });

  it('accepts an adapter the project installed under either specifier', async () => {
    const { code, config, installed } = await inProject(
      { 'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }) },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'npm');
        stubAdapterPackage(cwd, 'covsel-adapter-ava', 'ava');
        const captured = await capture(() =>
          main(['init', '--adapter', 'ava', '--auto-approve']),
        );
        return {
          ...captured,
          config: readFileSync(join(cwd, 'covsel.json'), 'utf8'),
          installed: existsSync(log),
        };
      },
    );

    // An installed adapter is the answer already; asking the registry again
    // would fail a project whose adapter came from somewhere else entirely.
    expect(code).toBe(0);
    expect(installed).toBe(false);
    expect(JSON.parse(config)).toEqual({ adapter: 'ava' });
  });

  it('writes no config when no specifier could be installed', async () => {
    const { code, files } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        stubPackageManager(cwd, 'npm', 1);
        const captured = await capture(() =>
          main(['init', '--adapter', 'nope', '--auto-approve']),
        );
        return {
          ...captured,
          files: {
            config: existsSync(join(cwd, 'covsel.json')),
            gitignore: existsSync(join(cwd, '.gitignore')),
          },
        };
      },
    );

    // The config is withheld — that is what installing first buys. Ignoring the
    // map directory is unrelated to the install and still happens.
    expect(code).not.toBe(0);
    expect(files).toEqual({ config: false, gitignore: true });
  });

  it('names the specifiers it asked the package manager for', async () => {
    const { err } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      (cwd) => {
        stubPackageManager(cwd, 'npm', 1);
        return capture(() => main(['init', '--adapter', 'nope', '--auto-approve']));
      },
    );

    expect(err).toContain('the install failed');
    expect(err).toContain('npm install --save-dev @covsel/adapter-nope');
    expect(err).toContain('npm install --save-dev covsel-adapter-nope');
    expect(err).toContain('No config was written');
    // What a failed install does and does not prove: a private registry, an
    // offline machine and a name with nothing behind it all look alike here.
    expect(err).not.toContain('does not exist');
    // The old order wrote first and installed second, and said so.
    expect(err).not.toContain('covsel is configured');
  });

  it('suggests the adapter a near-miss was probably meant to be', async () => {
    const { err } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      (cwd) => {
        stubPackageManager(cwd, 'npm', 1);
        return capture(() => main(['init', '--adapter', 'vitesst', '--auto-approve']));
      },
    );

    expect(err).toContain('covsel init --adapter vitest');
  });

  it('claims no rollback when a failed install had nothing to roll back', async () => {
    const { code, err, config } = await inProject(
      {
        'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
        'covsel.json': `${JSON.stringify({ adapter: 'vitest' })}\n`,
      },
      async (cwd) => {
        stubPackageManager(cwd, 'npm', 1);
        // The adapter is present and only its support package is missing, which
        // is what puts the failure on a project that already had its config.
        // Stated here rather than inherited from whatever resolves around the
        // test process, which would make this pass for the wrong reason.
        stubAdapterPackage(cwd, '@covsel/adapter-vitest', 'vitest');
        const captured = await capture(() => main(['init', '--auto-approve']));
        return { ...captured, config: readFileSync(join(cwd, 'covsel.json'), 'utf8') };
      },
    );

    expect(code).not.toBe(0);
    expect(err).toContain('the install failed');
    expect(err).toContain('npm install --save-dev @vitest/coverage-v8');
    // The config was the project's already, so "nothing was written" would read
    // as covsel having taken it away.
    expect(err).toContain('already names vitest');
    expect(err).not.toContain('No config was written');
    expect(JSON.parse(config)).toEqual({ adapter: 'vitest' });
  });

  it('writes the config under --no-install, where no install can vouch for it', async () => {
    const { code, out, config, installed } = await inProject(
      { 'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }) },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'npm');
        const captured = await capture(() =>
          main(['init', '--adapter', 'private-thing', '--no-install', '--auto-approve']),
        );
        return {
          ...captured,
          config: readFileSync(join(cwd, 'covsel.json'), 'utf8'),
          installed: existsSync(log),
        };
      },
    );

    // --no-install says the project brings its own packages, so there is no
    // install to prove the name with and nothing to withhold the config for —
    // the way in for an adapter from a private registry or a workspace link.
    expect(code).toBe(0);
    expect(installed).toBe(false);
    expect(JSON.parse(config)).toEqual({ adapter: 'private-thing' });
    expect(out).toContain('npm install --save-dev @covsel/adapter-private-thing');
  });
});

/**
 * Install an adapter into the project whose `createRecorder` refuses. A real one
 * does this when it cannot record — the Vitest adapter checks for its coverage
 * provider up front — and a stub keeps this test on the CLI's handling of the
 * refusal, without depending on a built workspace adapter.
 */
function stubRefusingAdapter(cwd: string, message: string): void {
  const dir = join(cwd, 'node_modules', 'covsel-adapter-refusing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({
      name: 'covsel-adapter-refusing',
      type: 'module',
      main: 'index.js',
    })}\n`,
  );
  writeFileSync(
    join(dir, 'index.js'),
    'export const adapter = {\n' +
      "  name: 'refusing',\n" +
      '  formatSelection: (tests) => tests.map((t) => t.file),\n' +
      `  createRecorder: () => { throw new Error(${JSON.stringify(message)}); },\n` +
      '};\n',
  );
}

describe('covsel init — consent', () => {
  it('changes nothing with no terminal and no --auto-approve', async () => {
    const { code, err, files } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'npm');
        const captured = await capture(() => main(['init']));
        return {
          ...captured,
          files: {
            config: existsSync(join(cwd, 'covsel.json')),
            gitignore: existsSync(join(cwd, '.gitignore')),
            installed: existsSync(log),
          },
        };
      },
    );

    // The test process has no TTY, which is exactly the CI/agent case.
    expect(code).toBe(1);
    expect(files).toEqual({ config: false, gitignore: false, installed: false });
    expect(err).toContain('nothing changed');
    expect(err).toContain('--auto-approve');
  });

  it('still shows the plan it did not carry out', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        // Stubbed so a regression in the guard fails the test rather than
        // silently reaching the network for a real install.
        stubPackageManager(cwd, 'npm');
        return capture(() => main(['init']));
      },
    );

    expect(code).toBe(1);
    expect(out).toContain('detected vitest');
    expect(out).toContain('Plan:');
  });

  it('carries the plan out when told to', async () => {
    const { code, installed } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'npm');
        const captured = await capture(() => main(['init', '--auto-approve']));
        return { ...captured, installed: readFileSync(log, 'utf8').trim() };
      },
    );

    // The workspace adapters all resolve in-process here, so what is left to
    // install is the coverage provider — enough to prove the install ran.
    expect(code).toBe(0);
    expect(installed).toContain('@vitest/coverage-v8');
  });
});

/**
 * Drive the prompt. A vitest worker has no TTY, so reaching `confirm` at all
 * means saying it has one — and the answer has to come from somewhere, hence the
 * readline stub. Without this the headline behaviour of the command, what
 * happens when you answer, has no coverage at all.
 */
async function answering<T>(answer: string, fn: () => Promise<T>): Promise<T> {
  const stdin = process.stdin as { isTTY?: boolean };
  const had = Object.prototype.hasOwnProperty.call(stdin, 'isTTY');
  const previous = stdin.isTTY;
  Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
  readlineAnswer = answer;
  try {
    return await fn();
  } finally {
    if (had)
      Object.defineProperty(stdin, 'isTTY', { value: previous, configurable: true });
    else delete stdin.isTTY;
  }
}

describe('covsel init — what "already set up" means', () => {
  const configured = {
    'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    'covsel.json': `${JSON.stringify({ adapter: 'vitest' })}\n`,
    '.gitignore': '.covsel/\n',
  };

  it('is not claimed while a package recording needs is missing', async () => {
    // --no-install must not turn "your coverage provider is absent" into
    // "already set up": that reads as done and fails at the first record.
    const { out } = await inProject(configured, () =>
      capture(() => main(['init', '--no-install'])),
    );

    expect(out).not.toContain('already set up');
    expect(out).toContain('skip     installing');
    expect(out).toContain('@vitest/coverage-v8');
  });

  it('reports a project with nothing left to do, and asks nothing', async () => {
    const { code, out } = await inProject(
      {
        ...configured,
        'package.json': pkg({
          devDependencies: { vitest: '^3.0.0', '@vitest/coverage-v8': '^3.0.0' },
        }),
      },
      () => capture(() => main(['init', '--no-install'])),
    );

    expect(code).toBe(0);
    expect(out).toContain('already set up');
  });

  it('exits 0 without prompting when --no-install leaves nothing to apply', async () => {
    // The packages were the only outstanding thing and we were told not to
    // install them, so there is nothing to consent to — not even with no TTY.
    const { code, err } = await inProject(configured, () =>
      capture(() => main(['init', '--no-install'])),
    );

    expect(code).toBe(0);
    expect(err).not.toContain('--auto-approve');
  });
});

describe('covsel init — answering the prompt', () => {
  it('writes nothing when the answer is no', async () => {
    const { code, out, files } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'npm');
        const captured = await answering('n', () => capture(() => main(['init'])));
        return {
          ...captured,
          files: {
            config: existsSync(join(cwd, 'covsel.json')),
            gitignore: existsSync(join(cwd, '.gitignore')),
            installed: existsSync(log),
          },
        };
      },
    );

    // Declining the plan declines all of it — that is what "no" has to mean, or
    // there is no way to say it.
    expect(code).toBe(0);
    expect(files).toEqual({ config: false, gitignore: false, installed: false });
    expect(out).toContain('nothing changed');
  });

  it.each(['', 'y', 'YES'])('carries the plan out for %o', async (answer) => {
    const { code, config, installed } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'npm');
        const captured = await answering(answer, () => capture(() => main(['init'])));
        return {
          ...captured,
          config: existsSync(join(cwd, 'covsel.json')),
          installed: existsSync(log) ? readFileSync(log, 'utf8').trim() : '',
        };
      },
    );

    expect(code).toBe(0);
    expect(config).toBe(true);
    expect(installed).toContain('@vitest/coverage-v8');
  });
});

describe('covsel init — --no-install', () => {
  it('puts the skipped install in the plan, with the command it needs', async () => {
    const { out } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      () => capture(() => main(['init', '--no-install'])),
    );

    // Agreeing to a --no-install plan means agreeing to finish the install, so
    // the plan has to say which packages and how.
    expect(out).toContain('skip     installing');
    expect(out).toContain('@vitest/coverage-v8');
    expect(out).toContain('npm install --save-dev');
  });

  it('configures without invoking a package manager, and says what is left', async () => {
    const { code, out, config, installed } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'npm');
        const captured = await capture(() =>
          main(['init', '--no-install', '--auto-approve']),
        );
        return {
          ...captured,
          config: existsSync(join(cwd, 'covsel.json')),
          installed: existsSync(log),
        };
      },
    );

    expect(code).toBe(0);
    expect(config).toBe(true);
    expect(installed).toBe(false);
    expect(out).toContain('not installed (--no-install)');
    expect(out).toContain('npm install --save-dev');
  });
});

describe('covsel init — when the install fails', () => {
  it('ignores the map directory anyway, and says so', async () => {
    // The gitignore line never depended on the install: whether covsel can
    // record has no bearing on whether its output belongs in version control,
    // and the user agreed to that line of the plan.
    const { code, err, gitignore } = await inProject(
      {
        'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
        'covsel.json': `${JSON.stringify({ adapter: 'vitest' })}\n`,
      },
      async (cwd) => {
        stubPackageManager(cwd, 'npm', 1);
        const captured = await capture(() => main(['init', '--auto-approve']));
        return { ...captured, gitignore: existsSync(join(cwd, '.gitignore')) };
      },
    );

    expect(code).not.toBe(0);
    expect(gitignore).toBe(true);
    expect(err).toContain('map directory is ignored');
  });

  it('does not blame the adapter when only a support package failed', async () => {
    const { err } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        // The adapter resolves in-process here, so the only thing installed is
        // the coverage provider — nothing about the adapter name is at stake.
        stubPackageManager(cwd, 'npm', 1);
        return capture(() => main(['init', '--auto-approve']));
      },
    );

    expect(err).toContain('@vitest/coverage-v8');
    expect(err).not.toContain('an adapter that could not be installed');
  });

  it('does not try another package name when the install was interrupted', async () => {
    // Ctrl-C during the scoped install must not escalate into installing a
    // differently-named, unscoped package and reporting success.
    const { code, config, installed } = await inProject(
      { 'package.json': pkg({}) },
      async (cwd) => {
        const log = stubPackageManager(cwd, 'npm', 0, undefined, '@covsel/adapter-nope');
        const captured = await capture(() =>
          main(['init', '--adapter', 'nope', '--auto-approve']),
        );
        return {
          ...captured,
          config: existsSync(join(cwd, 'covsel.json')),
          installed: readFileSync(log, 'utf8'),
        };
      },
    );

    expect(code).not.toBe(0);
    expect(config).toBe(false);
    expect(installed).not.toContain('covsel-adapter-nope');
  });
});

describe('an adapter that cannot record', () => {
  it('record reports the refusal instead of crashing', async () => {
    const refusal = '@vitest/coverage-v8 is not installed';
    const { code, err } = await inProject({ 'package.json': pkg({}) }, async (cwd) => {
      stubRefusingAdapter(cwd, refusal);
      return capture(() => main(['record', '--adapter', 'refusing', '--', 'true']));
    });

    expect(code).toBe(1);
    expect(err).toContain('covsel record:');
    expect(err).toContain(refusal);
    // A message to act on, not a stack trace.
    expect(err).not.toMatch(/^\s+at /m);
  });
});

describe('covsel status on a map it cannot use', () => {
  /** Put `contents` at the path status prints, verbatim. */
  function writeMapFile(cwd: string, contents: string): void {
    mkdirSync(join(cwd, '.covsel'), { recursive: true });
    writeFileSync(join(cwd, '.covsel', 'map.json'), contents);
  }

  it('does not print the path of a file and then say it is not there', async () => {
    const { out } = await inProject({ 'package.json': pkg({}) }, async (cwd) => {
      writeMapFile(
        cwd,
        JSON.stringify({
          schemaVersion: MAP_SCHEMA_VERSION - 1,
          granularity: 'file',
          recordedAt: new Date().toISOString(),
          sentinelHashes: {},
          observed: ['**'],
          entries: [],
        }),
      );
      return captureStdout(() => main(['status']));
    });

    expect(out).toMatch(/exists: +yes, but not usable/);
    expect(out).not.toMatch(/exists: +no/);
    expect(out).toContain(`covsel reads v${MAP_SCHEMA_VERSION}`);
    expect(out).toContain('re-record');
  });

  it('says no when there really is no map', async () => {
    const { out } = await inProject({ 'package.json': pkg({}) }, () =>
      captureStdout(() => main(['status'])),
    );

    expect(out).toMatch(/exists: +no/);
  });

  it('does not describe a map it could not read', async () => {
    // The recorded-at, granularity, and entry counts below the header all come
    // from a map that parsed; printing them for one that did not would be the
    // same lie in the other direction.
    const { out } = await inProject({ 'package.json': pkg({}) }, async (cwd) => {
      writeMapFile(cwd, '{ "schemaVersion": ');
      return captureStdout(() => main(['status']));
    });

    expect(out).toMatch(/exists: +yes, but not usable/);
    expect(out).toContain('not valid JSON');
    expect(out).not.toContain('granularity');
    expect(out).not.toContain('entries:');
  });

  /** A map crediting one entry with `sources`, at the path status reads. */
  function writeSources(cwd: string, sources: string[]): void {
    writeMapFile(
      cwd,
      JSON.stringify({
        schemaVersion: MAP_SCHEMA_VERSION,
        granularity: 'file',
        recordedAt: new Date().toISOString(),
        sentinelHashes: {},
        observed: ['**'],
        entries: [
          {
            test: { file: 'test/a.test.js' },
            files: sources.map((file) => ({ file, fileHash: `sha256:${file}` })),
          },
        ],
      }),
    );
  }

  it('shows where the covered sources came from when they span directories', async () => {
    // `sources: 5` is the number people read to judge whether their globs say
    // what they meant, and alone it cannot answer that. The express shape,
    // shrunk: a little real source and a lot of examples.
    const { out } = await inProject({ 'package.json': pkg({}) }, async (cwd) => {
      writeSources(cwd, [
        'lib/application.js',
        'lib/router.js',
        'examples/auth/index.js',
        'examples/mvc/index.js',
        'examples/vhost/index.js',
      ]);
      return captureStdout(() => main(['status']));
    });

    expect(out).toMatch(/sources: +5/);
    // Biggest first, so the directory nobody meant to include reads first.
    expect(out).toMatch(/examples +3[\s\S]*lib +2/);
  });

  it('says nothing extra when every source is under one directory', async () => {
    // There the breakdown only restates the line above it.
    const { out } = await inProject({ 'package.json': pkg({}) }, async (cwd) => {
      writeSources(cwd, ['lib/application.js', 'lib/router.js']);
      return captureStdout(() => main(['status']));
    });

    expect(out).toMatch(/sources: +2/);
    expect(out).not.toMatch(/^ +lib +2$/m);
  });
});

describe('the persisted adapter', () => {
  it('is what a command uses when no flag is given', async () => {
    const { code, err } = await inProject(
      {
        'package.json': pkg({}),
        'covsel.json': `${JSON.stringify({ adapter: 'from-config' })}\n`,
      },
      () => capture(() => main(['record', '--', 'true'])),
    );

    expect(code).toBe(1);
    expect(err).toContain("adapter 'from-config' is not installed");
  });

  it('is overridden by an explicit --adapter', async () => {
    const { err } = await inProject(
      {
        'package.json': pkg({}),
        'covsel.json': `${JSON.stringify({ adapter: 'from-config' })}\n`,
      },
      () => capture(() => main(['record', '--adapter', 'from-flag', '--', 'true'])),
    );

    expect(err).toContain("adapter 'from-flag' is not installed");
    expect(err).not.toContain('from-config');
  });
});

/**
 * publish and fetch read and write real directories, so these run in a throwaway
 * project. The interesting behavior is in core (see `archive.test.ts`); what
 * matters here is that a CI job cannot be told a lie by the exit code.
 */
describe('covsel publish and fetch', () => {
  it('publish rejects a --keep that would archive nothing', async () => {
    const { code, err } = await inProject({ 'package.json': pkg({}) }, () =>
      capture(() => main(['publish', '--keep', '0'])),
    );
    expect(code).toBe(1);
    expect(err).toContain('--keep needs a whole number');
  });

  it('publish says to record first when there is no map', async () => {
    const { code, err } = await inProject({ 'package.json': pkg({}) }, () =>
      capture(() => main(['publish'])),
    );
    expect(code).toBe(1);
    expect(err).toContain('run covsel record first');
  });

  it('publish refuses a map that records no commit', async () => {
    const { code, err } = await inProject({ 'package.json': pkg({}) }, (cwd) => {
      writeMap(cwd, { recordedAt: '2026-07-01T00:00:00.000Z' });
      return capture(() => main(['publish']));
    });
    expect(code).toBe(1);
    expect(err).toContain('records no commit');
  });

  it('publish archives a map under its commit', async () => {
    const commit = 'a'.repeat(40);
    const { code, err, archived } = await inProject(
      { 'package.json': pkg({}) },
      async (cwd) => {
        writeMap(cwd, { commit, recordedAt: '2026-07-01T00:00:00.000Z' });
        const res = await capture(() => main(['publish']));
        return {
          ...res,
          archived: archivedUnder(join(cwd, '.covsel', 'archive'), commit),
        };
      },
    );
    expect(code).toBe(0);
    expect(err).toContain('archived aaaaaaaaaaaa');
    expect(archived).toBe(true);
  });

  it('publish honours --archive', async () => {
    const commit = 'b'.repeat(40);
    const { code, archived } = await inProject(
      { 'package.json': pkg({}) },
      async (cwd) => {
        writeMap(cwd, { commit, recordedAt: '2026-07-01T00:00:00.000Z' });
        const res = await capture(() => main(['publish', '--archive', 'maps']));
        return { ...res, archived: archivedUnder(join(cwd, 'maps'), commit) };
      },
    );
    expect(code).toBe(0);
    expect(archived).toBe(true);
  });

  it('fetch finding nothing exits 0 and says the next run is a full one', async () => {
    const { code, err } = await inProject({ 'package.json': pkg({}) }, () =>
      capture(() => main(['fetch'])),
    );
    expect(code).toBe(0);
    expect(err).toContain('full run');
  });

  it('fetch finding nothing exits non-zero with --require', async () => {
    const { code } = await inProject({ 'package.json': pkg({}) }, () =>
      capture(() => main(['fetch', '--require'])),
    );
    expect(code).toBe(1);
  });
});

/** Write a map with entries into a project's store. */
function writeEntries(cwd: string, entries: unknown[]): void {
  mkdirSync(join(cwd, '.covsel'), { recursive: true });
  writeFileSync(
    join(cwd, '.covsel', 'map.json'),
    JSON.stringify({
      schemaVersion: MAP_SCHEMA_VERSION,
      granularity: 'file',
      recordedAt: '2026-07-01T00:00:00.000Z',
      sentinelHashes: {},
      observed: ['**'],
      entries,
    }),
  );
}

/**
 * The reverse view over the map. The reading is in core (see `explain.test.ts`);
 * what matters here is that the answer a developer distrusting selection gets is
 * on stdout, and that a path covsel cannot explain says so instead of printing
 * an empty, reassuring report.
 */
describe('covsel explain', () => {
  it('names the tests that cover a source file', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({}), 'math.js': 'export const add = (a, b) => a + b;\n' },
      (cwd) => {
        writeEntries(cwd, [
          {
            test: { file: 'add.test.js', name: 'adds' },
            files: [{ file: 'math.js', fileHash: 'sha256:math' }],
          },
        ]);
        return capture(() => main(['explain', 'math.js']));
      },
    );
    expect(code).toBe(0);
    expect(out).toContain('add.test.js');
    expect(out).toContain('adds');
  });

  it('says what covers nothing means, and still exits 0', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({}), 'lonely.js': 'export const x = 1;\n' },
      (cwd) => {
        writeEntries(cwd, [
          {
            test: { file: 'add.test.js' },
            files: [{ file: 'math.js', fileHash: 'sha256:math' }],
          },
        ]);
        return capture(() => main(['explain', 'lonely.js']));
      },
    );
    expect(code).toBe(0);
    expect(out).toContain('no recorded test covers');
    expect(out).toContain('alwaysRun');
  });

  it('does not call an unobservable path covered by nothing', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({}), 'lonely.js': 'export const x = 1;\n' },
      (cwd) => {
        mkdirSync(join(cwd, '.covsel'), { recursive: true });
        writeFileSync(
          join(cwd, '.covsel', 'map.json'),
          JSON.stringify({
            schemaVersion: MAP_SCHEMA_VERSION,
            granularity: 'file',
            recordedAt: '2026-07-01T00:00:00.000Z',
            sentinelHashes: {},
            observed: ['math.js'],
            entries: [
              {
                test: { file: 'add.test.js' },
                files: [{ file: 'math.js', fileHash: 'sha256:math' }],
              },
            ],
          }),
        );
        return capture(() => main(['explain', 'lonely.js']));
      },
    );
    expect(code).toBe(0);
    expect(out).toContain('full run');
    expect(out).not.toContain('no recorded test covers');
  });

  it('says an unrecorded test always runs', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({}), 'fresh.test.js': '' },
      (cwd) => {
        writeEntries(cwd, [
          {
            test: { file: 'add.test.js' },
            files: [{ file: 'math.js', fileHash: 'sha256:math' }],
          },
        ]);
        return capture(() => main(['explain', 'fresh.test.js']));
      },
    );
    expect(code).toBe(0);
    expect(out).toContain('always runs');
  });

  it('says there is nothing to explain without a map, and exits 0', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({}), 'math.js': 'export const x = 1;\n' },
      () => capture(() => main(['explain', 'math.js'])),
    );
    expect(code).toBe(0);
    expect(out).toContain('full run');
  });

  it('exits non-zero naming a path it cannot explain', async () => {
    const { code, err } = await inProject({ 'package.json': pkg({}) }, (cwd) => {
      writeEntries(cwd, [{ test: { file: 'add.test.js' }, files: [] }]);
      return capture(() => main(['explain', 'nope.js']));
    });
    expect(code).toBe(1);
    expect(err).toContain('nope.js');
  });

  it('summarizes a large fan-in, and prints all of it for --all', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      test: { file: `t${i}.test.js` },
      files: [{ file: 'math.js', fileHash: 'sha256:math' }],
    }));
    const { out, all } = await inProject(
      { 'package.json': pkg({}), 'math.js': 'export const x = 1;\n' },
      async (cwd) => {
        writeEntries(cwd, entries);
        const summarized = await capture(() => main(['explain', 'math.js']));
        const everything = await capture(() => main(['explain', 'math.js', '--all']));
        return { ...summarized, all: everything.out };
      },
    );
    expect(out).toContain('and 20 more (--all)');
    expect(all).not.toContain('more (--all)');
    expect(all).toContain('t39.test.js');
  });

  it('summarizes a test file with more recorded units than it will print', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      test: { file: 'big.test.js', name: `case ${String(i).padStart(2, '0')}` },
      files: [{ file: 'math.js', fileHash: 'sha256:math' }],
    }));
    const { out } = await inProject(
      { 'package.json': pkg({}), 'big.test.js': '' },
      (cwd) => {
        writeEntries(cwd, entries);
        return capture(() => main(['explain', 'big.test.js']));
      },
    );
    expect(out).toContain('and 20 more unit(s) (--all)');
    expect(out).not.toContain('case 39');
  });

  it('exits non-zero when given no path at all', async () => {
    const { code, err } = await inProject({ 'package.json': pkg({}) }, () =>
      capture(() => main(['explain'])),
    );
    expect(code).toBe(1);
    expect(err).toContain('expected a path');
  });

  it('says a recorded test covering no source is selected every run', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({}), 'child.test.js': '' },
      (cwd) => {
        writeEntries(cwd, [{ test: { file: 'child.test.js' }, files: [] }]);
        return capture(() => main(['explain', 'child.test.js']));
      },
    );
    expect(code).toBe(0);
    // Not the unrecorded wording: the map does record this one, and a reader
    // has to be able to tell the two apart.
    expect(out).toContain('1 recorded unit(s)');
    expect(out).toContain('covers no source');
    expect(out).toContain('selected on every run');
  });
});

/**
 * A map entry that credits nothing is unselectable by any diff, so selection
 * runs its test file whatever changed. That makes it a cost rather than a hole
 * — and a silent one, since the entry looks like any other in the map. These
 * cover the two places covsel says so out loud.
 */
describe('an entry that covers no source', () => {
  it('is counted by status rather than folded into the entry count', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({}), 'child.test.js': '' },
      (cwd) => {
        writeEntries(cwd, [
          { test: { file: 'child.test.js' }, files: [] },
          {
            test: { file: 'add.test.js' },
            files: [{ file: 'math.js', fileHash: 'sha256:math' }],
          },
        ]);
        return capture(() => main(['status']));
      },
    );
    expect(code).toBe(0);
    expect(out).toContain('entries:    2');
    expect(out).toContain('unmeasured: 1');
  });

  it('leaves status quiet when every entry measured something', async () => {
    const { out } = await inProject(
      { 'package.json': pkg({}), 'math.js': 'export const x = 1;\n' },
      (cwd) => {
        writeEntries(cwd, [
          {
            test: { file: 'add.test.js' },
            files: [{ file: 'math.js', fileHash: 'sha256:math' }],
          },
        ]);
        return capture(() => main(['status']));
      },
    );
    expect(out).not.toContain('unmeasured');
  });
});
