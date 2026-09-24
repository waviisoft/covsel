import { resolveConfig } from '@covsel/core';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { harnessAdapter } from '../src/index.js';

/**
 * `runSelection`'s empty-selection guard, exercised end to end against a real
 * command rather than a synthetic stand-in for one -- the property that
 * matters is that the command never runs at all, not just that a mock saw no
 * call, so this proves it the same way the rest of this package's tests
 * prove things: with a real process and a real, observable side effect.
 */
describe('harnessAdapter.runSelection', () => {
  it('never spawns the harness command for an empty selection', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-adapter-harness-runselection-'));
    const marker = join(cwd, 'ran');
    const config = resolveConfig({
      adapter: 'harness',
      harness: { run: '--only {id}', server: { observes: ['**'] } },
    });

    const status = harnessAdapter.runSelection!({
      // If this ever ran, it would prove it by writing `marker` -- appending
      // `--only <id>` per selected test, which an empty selection must never
      // reach at all.
      command: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        '--',
      ],
      selected: [],
      cwd,
      stdio: 'ignore',
      config,
    });

    expect(status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('does spawn the command for a non-empty selection, as a control on the assertion above', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-adapter-harness-runselection-'));
    const marker = join(cwd, 'ran');
    const config = resolveConfig({
      adapter: 'harness',
      harness: { run: '--only {id}', server: { observes: ['**'] } },
    });

    const status = harnessAdapter.runSelection!({
      command: [
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(1).join(' '))`,
        '--',
      ],
      selected: [{ file: 'a.harness' }],
      cwd,
      stdio: 'ignore',
      config,
    });

    expect(status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
});
