import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '@covsel/core';

import { vitestAdapter } from '../src/index.js';

describe('vitest adapter', () => {
  it('identifies itself as "vitest"', () => {
    expect(vitestAdapter.name).toBe('vitest');
  });

  it('formats a selection as a deduplicated file list', () => {
    const out = vitestAdapter.formatSelection([
      { file: 'test/a.test.ts', name: 'one' },
      { file: 'test/a.test.ts', name: 'two' },
      { file: 'test/b.test.ts' },
    ]);
    expect(out).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });

  it('returns an empty list for no tests', () => {
    expect(vitestAdapter.formatSelection([])).toEqual([]);
  });

  describe('recording pre-flight', () => {
    const dirs: string[] = [];
    afterAll(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });

    const project = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'covsel-vitest-preflight-'));
      dirs.push(dir);
      writeFileSync(join(dir, 'package.json'), '{"name":"fixture","private":true}\n');
      return dir;
    };

    const config = resolveConfig();

    it('refuses to record without the coverage provider, before running anything', () => {
      expect(() =>
        vitestAdapter.createRecorder({
          command: ['vitest', 'run'],
          cwd: project(),
          config,
        }),
      ).toThrow(/@vitest\/coverage-v8 is not installed/);
    });

    it('names the install command in the refusal', () => {
      let message = '';
      try {
        vitestAdapter.createRecorder({
          command: ['vitest', 'run'],
          cwd: project(),
          config,
        });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain('npm install --save-dev @vitest/coverage-v8');
      expect(message).toContain('covsel init');
    });

    it('builds a recorder when the provider is installed', () => {
      // The vitest example really does install it, so this is the positive case
      // against a real tree rather than a stub.
      const cwd = fileURLToPath(
        new URL('../../../examples/vitest-basic', import.meta.url),
      );
      expect(() =>
        vitestAdapter.createRecorder({
          command: ['vitest', 'run'],
          cwd,
          config,
        }),
      ).not.toThrow();
    });
  });
});
