import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The reporter as the action actually invokes it: a script, reading files it was
 * pointed at, writing the two files GitHub gives it.
 *
 * The pure functions are covered in `report.test.ts`. What is only reachable
 * here is the part that decides whether a step passes at all -- and the case
 * worth pinning is the refusal, because the alternative to failing is a green
 * step reporting a selection nobody measured.
 */

const REPORTER = fileURLToPath(new URL('../report.mjs', import.meta.url));
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Run the reporter over a directory holding the given command output. */
function run(
  files: Record<string, unknown>,
  env: Record<string, string> = {},
): { status: number | null; outputs: string; summary: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-report-'));
  dirs.push(dir);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  }
  const outputFile = join(dir, 'github-output');
  const summaryFile = join(dir, 'github-summary');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  const res = spawnSync(process.execPath, [REPORTER, dir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      COVSEL_MODE: 'select',
      ...env,
    },
  });
  return {
    status: res.status,
    outputs: readFileSync(outputFile, 'utf8'),
    summary: readFileSync(summaryFile, 'utf8'),
    stderr: res.stderr,
  };
}

const status = {
  mapPath: '/repo/.covsel/map.json',
  mapState: 'usable',
  discoveredTestCount: 2,
  changedSentinels: [],
  nextIsFullRun: false,
};

describe('the reporter as a script', () => {
  it('writes the outputs and the summary a step is read through', () => {
    const result = run({
      'covsel-affected.json': {
        fullRun: false,
        files: ['a.test.js'],
        tests: ['a.test.js'],
        selected: [{ file: 'a.test.js' }],
        discovered: 2,
      },
      'covsel-status.json': status,
    });

    expect(result.status).toBe(0);
    expect(result.outputs).toContain('full-run=false');
    expect(result.outputs).toContain('selected-count=1');
    expect(result.outputs).toContain('affected=["a.test.js"]');
    expect(result.summary).toContain('Selected 1 of 2 test file(s)');
  });

  it('refuses a select run whose selection it could not read', () => {
    // The alternative is the failure this guard exists for: a green step
    // reporting "selected 0" for a narrowing that was never measured.
    const result = run({ 'covsel-status.json': status });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nothing to report');
    expect(result.outputs).toBe('');
  });

  it('still reports in record mode, where there is no selection to read', () => {
    const result = run({ 'covsel-status.json': status }, { COVSEL_MODE: 'record' });

    expect(result.status).toBe(0);
    expect(result.outputs).toContain('map-state=usable');
    // No selection was attempted, so no count is claimed for one.
    expect(result.outputs).toContain('selected-count=\n');
  });

  it('writes no summary when the caller turned it off, but still sets outputs', () => {
    const result = run(
      {
        'covsel-affected.json': {
          fullRun: true,
          reason: 'no map',
          tests: [],
          discovered: 0,
        },
        'covsel-status.json': status,
      },
      { COVSEL_SUMMARY: 'false' },
    );

    expect(result.status).toBe(0);
    expect(result.summary).toBe('');
    expect(result.outputs).toContain('full-run=true');
  });

  it('does not read a sibling invocation working directory', () => {
    // Each invocation is given its own directory precisely so a select and a
    // record in one job cannot report each other's numbers. Pointed at a
    // directory with nothing in it, the reporter says so rather than reaching
    // for whatever RUNNER_TEMP happens to hold.
    const result = run({}, { RUNNER_TEMP: '/tmp' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nothing to report');
  });
});
