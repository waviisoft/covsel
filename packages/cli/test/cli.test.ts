import { describe, expect, it, vi } from 'vitest';
import { MAP_SCHEMA_VERSION } from '@covsel/core';
import { VERSION, main } from '../src/index.js';

function captureStdout(fn: () => number): { code: number; out: string } {
  const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const code = fn();
  const out = spy.mock.calls.map((c) => String(c[0])).join('');
  spy.mockRestore();
  return { code, out };
}

function captureStderr(fn: () => number): { code: number; err: string } {
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const code = fn();
  const err = spy.mock.calls.map((c) => String(c[0])).join('');
  spy.mockRestore();
  return { code, err };
}

describe('covsel cli', () => {
  it('prints help and exits 0 with no args', () => {
    const { code, out } = captureStdout(() => main([]));
    expect(code).toBe(0);
    expect(out).toContain('covsel — runtime-coverage');
  });

  it.each(['-h', '--help'])('prints help for %s', (flag) => {
    const { code, out } = captureStdout(() => main([flag]));
    expect(code).toBe(0);
    expect(out).toContain('Usage:');
  });

  it('help surfaces the fail-open guarantee and current schema version', () => {
    const { out } = captureStdout(() => main(['--help']));
    expect(out).toContain('fail-open');
    expect(out).toContain(`Map schema v${MAP_SCHEMA_VERSION}`);
  });

  it('help does not advertise commands that are not implemented yet', () => {
    const { out } = captureStdout(() => main(['--help']));
    for (const cmd of ['record', 'affected', 'run', 'watch', 'explain', 'status']) {
      expect(out).not.toContain(`covsel ${cmd}`);
    }
  });

  it.each(['-v', '--version'])('prints the version for %s', (flag) => {
    const { code, out } = captureStdout(() => main([flag]));
    expect(code).toBe(0);
    expect(out.trim()).toBe(VERSION);
  });

  it.each(['affected', 'record', 'run', 'frobnicate'])(
    'rejects "%s" since no commands exist yet (exit 1)',
    (arg) => {
      const { code, err } = captureStderr(() => main([arg]));
      expect(code).toBe(1);
      expect(err).toContain('no commands are available yet');
    },
  );

  it('writes nothing to stderr on the help path', () => {
    const { err } = captureStderr(() => main([]));
    expect(err).toBe('');
  });
});
