import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(out).toContain('covsel — runtime-coverage');
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
    for (const cmd of ['record', 'affected', 'run', 'status']) {
      expect(out).toContain(`covsel ${cmd}`);
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
  it('configures a detected project and prints the next steps', async () => {
    const result = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      async (cwd) => {
        const captured = await capture(() => main(['init']));
        return { ...captured, config: readFileSync(join(cwd, '.covsel.json'), 'utf8') };
      },
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain('adapter: vitest');
    expect(result.out).toContain('covsel record --adapter vitest');
    expect(JSON.parse(result.config)).toEqual({ adapter: 'vitest' });
  });

  it('exits non-zero and points at an adapter request when nothing is detected', async () => {
    const { code, err } = await inProject(
      { 'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }) },
      () => capture(() => main(['init'])),
    );

    expect(code).toBe(1);
    expect(err).toContain('no supported test runner detected');
    expect(err).toContain('adapter_request.yml');
    expect(err).toContain('covsel init --adapter');
    expect(err).toContain(`covsel:          ${VERSION}`);
  });

  it('refuses a known transforming runner and explains the fail-closed risk', async () => {
    const { code, err } = await inProject(
      { 'package.json': pkg({ devDependencies: { jest: '^29.0.0' } }) },
      () => capture(() => main(['init'])),
    );

    expect(code).toBe(1);
    expect(err).toContain('jest');
    expect(err).toContain('would select nothing');
    expect(err).toContain('Keep running this suite in full');
  });

  it('rejects an unknown adapter', async () => {
    const { code, err } = await inProject(
      { 'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }) },
      () => capture(() => main(['init', '--adapter', 'nope'])),
    );

    expect(code).toBe(1);
    expect(err).toContain("unknown adapter 'nope'");
  });
});

describe('the persisted adapter', () => {
  it('is what record uses when no flag is given', async () => {
    const { code, err } = await inProject(
      {
        'package.json': pkg({}),
        '.covsel.json': `${JSON.stringify({ adapter: 'bogus' })}\n`,
      },
      () => capture(() => main(['record', '--', 'true'])),
    );

    expect(code).toBe(1);
    expect(err).toContain("unknown adapter 'bogus' in your covsel config");
  });

  it('is overridden by an explicit --adapter', async () => {
    const { err } = await inProject(
      {
        'package.json': pkg({}),
        '.covsel.json': `${JSON.stringify({ adapter: 'bogus' })}\n`,
      },
      () => capture(() => main(['record', '--adapter', 'nope', '--', 'true'])),
    );

    expect(err).toContain("unknown adapter 'nope' from --adapter");
  });
});
