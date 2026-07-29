import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MAP_SCHEMA_VERSION } from '@covsel/core';
import { VERSION, main } from '../src/index.js';

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

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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

describe('covsel init', () => {
  it('names the adapter, writes the config, and prints the next steps', async () => {
    const result = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        const captured = await capture(() => main(['init', '--no-install']));
        return { ...captured, config: readFileSync(join(cwd, '.covsel.json'), 'utf8') };
      },
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain('detected vitest');
    expect(result.out).toContain('vitest is a dependency');
    expect(result.out).toContain('adapter: vitest');
    expect(result.out).toContain('covsel record --adapter vitest');
    expect(JSON.parse(result.config)).toEqual({ adapter: 'vitest' });
  });

  // Every workspace adapter resolves in-process here (vitest aliases them to
  // source), so a name nothing provides is what exercises the uninstalled path.
  it('plans the install of an adapter the project does not have', async () => {
    const { out } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      () => capture(() => main(['init', '--adapter', 'not-a-real-runner', '-y'])),
    );

    expect(out).toContain('install  @covsel/adapter-not-a-real-runner');
  });

  it('plans the install of what the runner needs beyond the adapter', async () => {
    const { out } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      () => capture(() => main(['init'])),
    );

    expect(out).toContain('@vitest/coverage-v8');
  });

  it('installs nothing under --no-install', async () => {
    const { code, out } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      () => capture(() => main(['init', '--no-install'])),
    );

    expect(code).toBe(0);
    expect(out).not.toContain('install ');
    expect(out).not.toContain('@vitest/coverage-v8');
  });

  it('reports a project that is already set up without redoing it', async () => {
    const { code, out } = await inProject(
      {
        'package.json': pkg({ devDependencies: { jest: '^29.0.0' } }),
        '.covsel.json': `${JSON.stringify({ adapter: 'jest' })}\n`,
        '.gitignore': '.covsel/\n',
      },
      () => capture(() => main(['init'])),
    );

    expect(code).toBe(0);
    expect(out).toContain('already set up');
    expect(out).toContain('covsel record --adapter jest');
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
          config: existsSync(join(cwd, '.covsel.json')),
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

describe('the persisted adapter', () => {
  it('is what a command uses when no flag is given', async () => {
    const { code, err } = await inProject(
      {
        'package.json': pkg({}),
        '.covsel.json': `${JSON.stringify({ adapter: 'from-config' })}\n`,
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
        '.covsel.json': `${JSON.stringify({ adapter: 'from-config' })}\n`,
      },
      () => capture(() => main(['record', '--adapter', 'from-flag', '--', 'true'])),
    );

    expect(err).toContain("adapter 'from-flag' is not installed");
    expect(err).not.toContain('from-config');
  });
});
