import { describe, expect, it, vi } from 'vitest';
import { MAP_SCHEMA_VERSION } from '@covsel/core';
import { VERSION, main } from '../src/index.js';

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
});
