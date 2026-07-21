import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Level-0 bet: run a test *file* in its own process with NODE_V8_COVERAGE
 * and you can attribute exactly which source files it executed, with zero
 * runner integration. This test guards that mechanism against regressions —
 * the shared helper must show up under both test files, and neither test file
 * may claim the other's source.
 */
const fixtureRoot = fileURLToPath(new URL('./fixtures/sample/', import.meta.url));
const srcDir = resolve(fixtureRoot, 'src');

interface ScriptCoverage {
  url: string;
  functions: { ranges: { count: number }[] }[];
}

/** Run one test file in its own process; return the src/** files it executed. */
function coveredSources(testFile: string): string[] {
  const covDir = mkdtempSync(join(tmpdir(), 'covsel-cov-'));
  try {
    const res = spawnSync(process.execPath, ['--test', resolve(fixtureRoot, testFile)], {
      env: { ...process.env, NODE_V8_COVERAGE: covDir },
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`fixture test failed for ${testFile}:\n${res.stdout}${res.stderr}`);
    }

    const covered = new Set<string>();
    for (const dump of readdirSync(covDir).filter((f) => f.endsWith('.json'))) {
      const { result } = JSON.parse(readFileSync(join(covDir, dump), 'utf8')) as {
        result: ScriptCoverage[];
      };
      for (const script of result) {
        if (!script.url.startsWith('file://')) continue; // skip node internals
        const path = fileURLToPath(script.url);
        if (!path.startsWith(srcDir + sep)) continue; // only src/**
        const executed = script.functions.some((fn) =>
          fn.ranges.some((r) => r.count > 0),
        );
        if (executed) covered.add(relative(fixtureRoot, path).replaceAll(sep, '/'));
      }
    }
    return [...covered].sort();
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
}

describe('Level-0 coverage observation (NODE_V8_COVERAGE)', () => {
  it('maps a test file to exactly the sources it executes', () => {
    expect(coveredSources('suite/a.test.mjs')).toEqual(['src/a.mjs', 'src/shared.mjs']);
  }, 30_000);

  it('does not attribute an unrelated source to a test file', () => {
    const covered = coveredSources('suite/b.test.mjs');
    expect(covered).toEqual(['src/b.mjs', 'src/shared.mjs']);
    expect(covered).not.toContain('src/a.mjs');
  }, 30_000);
});
