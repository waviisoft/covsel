import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  type CoverageMap,
  createGenericRecorder,
  FileSelector,
  MAP_SCHEMA_VERSION,
  recordMap,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * The fail-open acceptance suite. It records a real map by running a `node
 * --test` fixture under NODE_V8_COVERAGE (the Level-0 mechanism), then asserts
 * every rule that keeps covsel from ever skipping a test a change could break —
 * the mutation guard most of all.
 */

const config = resolveConfig();

const FILES: Record<string, string> = {
  'src/shared.mjs': `export function tag(s) {\n  return \`[covsel] \${s}\`;\n}\n`,
  'src/a.mjs': `import { tag } from './shared.mjs';\nexport function alpha(x) {\n  return tag(\`alpha:\${x * 2}\`);\n}\n`,
  'src/b.mjs': `import { tag } from './shared.mjs';\nexport function beta(x) {\n  return tag(\`beta:\${x + 1}\`);\n}\n`,
  'test/a.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { alpha } from '../src/a.mjs';\ntest('alpha', () => assert.equal(alpha(2), '[covsel] alpha:4'));\n`,
  'test/b.test.mjs': `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { beta } from '../src/b.mjs';\ntest('beta', () => assert.equal(beta(2), '[covsel] beta:3'));\n`,
  'package.json': `{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n`,
  'tsconfig.json': `{\n  "compilerOptions": { "strict": true }\n}\n`,
  '.gitignore': `.covsel/\n`,
};

let cwd: string;
let recordedMap: CoverageMap;
let mapBackup: string;

function git(args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function write(rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** Restore the fixture to its recorded baseline between tests. */
function reset(): void {
  git(['checkout', '--', '.']);
  git(['clean', '-fd']);
  writeFileSync(join(cwd, config.store.dir, 'map.json'), mapBackup);
}

beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-accept-'));
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'fixture']);

  const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
  const result = await recordMap({ cwd, config, recorder });
  expect(result.ok).toBe(true);
  expect(result.recorded).toBe(2);
  recordedMap = result.map!;
  mapBackup = JSON.stringify(recordedMap, null, 2);
}, 60_000);

afterEach(() => reset());

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

/** Set of source files a given test entry recorded. */
function coveredBy(testFile: string): string[] {
  const entry = recordedMap.entries.find((e) => e.test.file === testFile);
  return (entry?.files ?? []).map((f) => f.file).sort();
}

describe('recorded map', () => {
  it('attributes each test file to exactly the sources it executes', () => {
    expect(coveredBy('test/a.test.mjs')).toEqual(['src/a.mjs', 'src/shared.mjs']);
    expect(coveredBy('test/b.test.mjs')).toEqual(['src/b.mjs', 'src/shared.mjs']);
  });
});

describe('fail-open acceptance', () => {
  it('1. precision: editing src/a.ts selects a.test and not b.test', async () => {
    write('src/a.mjs', `${FILES['src/a.mjs']}// touch\n`);
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('2. shared code: editing src/shared.ts selects both test files', async () => {
    write('src/shared.mjs', `${FILES['src/shared.mjs']}// touch\n`);
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  });

  it('3. sentinel change forces a full run over every test file', async () => {
    write('package.json', FILES['package.json']!.replace('fixture', 'fixture2'));
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.tests).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  });

  it('3b. a tsconfig*.json sentinel also forces a full run', async () => {
    write('tsconfig.json', FILES['tsconfig.json']!.replace('true', 'false'));
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.tests).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  });

  it('4. a brand-new test file always runs, even absent from the map', async () => {
    write('test/c.test.mjs', FILES['test/a.test.mjs']!);
    const result = await selectAffected({ cwd, config });
    expect(result.tests).toContain('test/c.test.mjs');
  });

  it('5. a missing map forces a full run, never an empty selection', async () => {
    rmSync(join(cwd, config.store.dir, 'map.json'));
    write('src/a.mjs', `${FILES['src/a.mjs']}// touch\n`);
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.tests).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  });

  it('5b. a wrong-schema map forces a full run', async () => {
    const stale = { ...recordedMap, schemaVersion: MAP_SCHEMA_VERSION - 1 };
    writeFileSync(join(cwd, config.store.dir, 'map.json'), JSON.stringify(stale));
    write('src/a.mjs', `${FILES['src/a.mjs']}// touch\n`);
    const result = await selectAffected({ cwd, config });
    expect(result.fullRun).toBe(true);
    expect(result.tests).toEqual(['test/a.test.mjs', 'test/b.test.mjs']);
  });

  it('6. mutation guard: changing any source selects at least the tests covering it', async () => {
    const sources = new Set<string>();
    for (const entry of recordedMap.entries)
      for (const f of entry.files) sources.add(f.file);
    expect(sources.size).toBeGreaterThan(0);

    const selector = new FileSelector();
    for (const source of sources) {
      const expected = recordedMap.entries
        .filter((e) => e.files.some((f) => f.file === source))
        .map((e) => e.test.file);
      const selected = (
        await selector.affected(recordedMap, [{ file: source, kind: 'modified' }])
      ).map((t) => t.file);
      for (const test of expected) {
        expect(selected, `editing ${source} must select ${test}`).toContain(test);
      }
    }
  });
});
