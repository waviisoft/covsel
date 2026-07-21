#!/usr/bin/env node
/**
 * Observer spike (DESIGN.md §13.6, seed issue #9 de-risk).
 *
 * Proves the Level-0 contract: run each test *file* in its own process with
 * NODE_V8_COVERAGE, parse the V8 dump, and get a correct per-file
 * test-file → covered-source-files map with ZERO runner integration.
 *
 * Expectations asserted below:
 *   tests/a.test.mjs → src/a.mjs + src/shared.mjs (and NOT src/b.mjs)
 *   tests/b.test.mjs → src/b.mjs + src/shared.mjs (and NOT src/a.mjs)
 *
 * Exit 0 = spike passed; the MVP approach is sound.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = resolve(here, 'src');
const testFiles = ['tests/a.test.mjs', 'tests/b.test.mjs'];

/** Run one test file in its own process, return covered src/** files. */
function coveredSources(testFile) {
  const covDir = mkdtempSync(join(tmpdir(), 'covsel-spike-'));
  try {
    const res = spawnSync(process.execPath, ['--test', join(here, testFile)], {
      env: { ...process.env, NODE_V8_COVERAGE: covDir },
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      throw new Error(`test process failed for ${testFile}:\n${res.stdout}${res.stderr}`);
    }

    const covered = new Set();
    for (const dump of readdirSync(covDir).filter((f) => f.endsWith('.json'))) {
      const { result } = JSON.parse(readFileSync(join(covDir, dump), 'utf8'));
      for (const script of result) {
        if (!script.url.startsWith('file://')) continue; // skip node internals
        const path = fileURLToPath(script.url);
        if (!path.startsWith(srcDir + sep)) continue; // only src/**
        const executed = script.functions.some((fn) =>
          fn.ranges.some((r) => r.count > 0),
        );
        if (executed) covered.add(relative(here, path).replaceAll(sep, '/'));
      }
    }
    return [...covered].sort();
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
}

const map = Object.fromEntries(testFiles.map((t) => [t, coveredSources(t)]));

console.log('per-file map:');
console.log(JSON.stringify(map, null, 2));

const expected = {
  'tests/a.test.mjs': ['src/a.mjs', 'src/shared.mjs'],
  'tests/b.test.mjs': ['src/b.mjs', 'src/shared.mjs'],
};

let ok = true;
for (const [test, want] of Object.entries(expected)) {
  const got = map[test] ?? [];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    ok = false;
    console.error(`FAIL ${test}: expected ${want}, got ${got}`);
  }
}

if (ok) {
  console.log('\nSPIKE PASSED — NODE_V8_COVERAGE yields a correct per-file map.');
  console.log('The Level-0 MVP approach is de-risked.');
} else {
  process.exitCode = 1;
}
