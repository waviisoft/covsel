import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
    for (const cmd of ['record', 'affected', 'run', 'watch', 'status']) {
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
 * reaching the network. Returns the file it logs its arguments to.
 */
function stubPackageManager(cwd: string, name: string, exitCode = 0): string {
  const bin = join(cwd, 'stub-bin');
  const log = join(cwd, 'install.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" >> ${log}\nexit ${exitCode}\n`);
  chmodSync(join(bin, name), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env['PATH'] ?? ''}`);
  return log;
}

describe('covsel init', () => {
  it('names the adapter, writes the config, and prints the next steps', async () => {
    const result = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
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

  it('reports an install that failed without pretending setup finished', async () => {
    const { code, err } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        stubPackageManager(cwd, 'npm', 1);
        return capture(() =>
          main(['init', '--adapter', 'not-a-real-runner', '--auto-approve']),
        );
      },
    );

    expect(code).toBe(1);
    expect(err).toContain('the install failed');
    expect(err).toContain('npm install --save-dev @covsel/adapter-not-a-real-runner');
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
      { 'package.json': pkg({ devDependencies: { '@playwright/test': '^1.0.0' } }) },
      () => capture(() => main(['init'])),
    );

    expect(code).toBe(1);
    expect(err).toContain('no adapter records playwright yet');
    expect(err).toContain('Keep running that suite in full');
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
          archived: existsSync(join(cwd, '.covsel', 'archive', `${commit}.json`)),
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
        return { ...res, archived: existsSync(join(cwd, 'maps', `${commit}.json`)) };
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
