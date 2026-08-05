import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectOutcomes } from '../src/outcomes.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'covsel-bench-outcomes-'));
  writeFileSync(join(dir, 'pass.mjs'), 'process.exit(0)\n');
  writeFileSync(join(dir, 'fail.mjs'), 'process.exit(1)\n');
  writeFileSync(join(dir, 'throw.mjs'), "throw new Error('boom')\n");
  writeFileSync(join(dir, 'hang.mjs'), 'setTimeout(() => {}, 60_000)\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('collectOutcomes', () => {
  it('reads a verdict per file from the runner exit status', () => {
    const outcomes = collectOutcomes({
      command: [process.execPath],
      cwd: dir,
      files: ['pass.mjs', 'fail.mjs'],
    });
    expect(outcomes.get('pass.mjs')).toBe('passed');
    expect(outcomes.get('fail.mjs')).toBe('failed');
  });

  it('reports every file it was asked about', () => {
    const outcomes = collectOutcomes({
      command: [process.execPath],
      cwd: dir,
      files: ['pass.mjs', 'fail.mjs'],
    });
    expect([...outcomes.keys()].sort()).toEqual(['fail.mjs', 'pass.mjs']);
  });

  it('treats a file that threw as failed', () => {
    const outcomes = collectOutcomes({
      command: [process.execPath],
      cwd: dir,
      files: ['throw.mjs'],
    });
    expect(outcomes.get('throw.mjs')).toBe('failed');
  });

  // A hung file that read as passed would hide a test the change broke, which
  // is the one direction the oracle must never be wrong in.
  it('treats a file that timed out as failed rather than passed', () => {
    const outcomes = collectOutcomes({
      command: [process.execPath],
      cwd: dir,
      files: ['hang.mjs'],
      timeoutMs: 500,
    });
    expect(outcomes.get('hang.mjs')).toBe('failed');
  });

  it('treats a runner that cannot start as failed', () => {
    const outcomes = collectOutcomes({
      command: ['covsel-benchmark-no-such-binary'],
      cwd: dir,
      files: ['pass.mjs'],
    });
    expect(outcomes.get('pass.mjs')).toBe('failed');
  });

  it('reports progress as each file finishes', () => {
    const seen: string[] = [];
    collectOutcomes({
      command: [process.execPath],
      cwd: dir,
      files: ['pass.mjs', 'fail.mjs'],
      onFile: (file, outcome) => seen.push(`${file}:${outcome}`),
    });
    expect(seen).toEqual(['pass.mjs:passed', 'fail.mjs:failed']);
  });

  it('refuses an empty command rather than spawning nothing', () => {
    expect(() => collectOutcomes({ command: [], cwd: dir, files: [] })).toThrow(
      'empty command',
    );
  });
});
