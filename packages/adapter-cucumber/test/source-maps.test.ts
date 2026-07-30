import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  type CovselConfig,
  type RecordEvent,
  recordMap,
  type RecordResult,
  resolveConfig,
} from '@covsel/core';

import { createCucumberRecorder } from '../src/index.js';

/**
 * The scenario recorder runs its mapper inside the cucumber process, so the
 * project's `sourceMaps` settings have to cross that boundary to mean anything.
 * The consequence when they do not is that a project whose steps reach their
 * code through an unmappable build cannot record at all, however explicitly it
 * accepted that gap — safe, since the failure is a refusal, and total.
 *
 * cucumber-js is not a dependency of this package, so the fixture borrows the
 * installed copy from the cucumber example, as the conformance suite does.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const exampleModules = fileURLToPath(
  new URL('../../../examples/cucumber-basic/node_modules', import.meta.url),
);
const cucumberBin = fileURLToPath(
  new URL(
    '../../../examples/cucumber-basic/node_modules/.bin/cucumber-js',
    import.meta.url,
  ),
);

const FILES: Record<string, string> = {
  'src/app.mjs': 'export function greet(n) {\n  return `hi ${n}`;\n}\n',
  // No `sourceMappingURL`: the build published no map, so nothing traces this
  // back to a source anyone wrote.
  'dist/widget.mjs': 'export function badge(s) {\n  return `[${s}]`;\n}\n',
  'features/demo.feature': [
    'Feature: demo',
    '',
    '  Scenario: badge scenario',
    '    When I badge a greeting',
    '',
  ].join('\n'),
  'features/steps.mjs': [
    "import assert from 'node:assert/strict';",
    "import { When } from '@cucumber/cucumber';",
    "import { greet } from '../src/app.mjs';",
    "import { badge } from '../dist/widget.mjs';",
    "When('I badge a greeting', function () {",
    "  assert.equal(badge(greet('x')), '[hi x]');",
    '});',
    '',
  ].join('\n'),
  'package.json': '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
  '.gitignore': '.covsel/\nnode_modules/\n',
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  if (!existsSync(coreDist)) {
    execSync('pnpm --filter @covsel/core build', { cwd: repoRoot, stdio: 'ignore' });
  }
}, 120_000);

function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-cucumber-maps-'));
  dirs.push(cwd);
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(cwd, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  symlinkSync(exampleModules, join(cwd, 'node_modules'), 'dir');
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'covsel test'],
    ['add', '.'],
    ['commit', '-q', '-m', 'fixture'],
  ]) {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }
  return cwd;
}

async function record(
  cwd: string,
  config: CovselConfig,
): Promise<{ result: RecordResult; events: RecordEvent[] }> {
  const recorder = createCucumberRecorder({ command: [cucumberBin], cwd, config });
  const events: RecordEvent[] = [];
  const result = await recordMap({
    cwd,
    config,
    recorder,
    onEvent: (e) => events.push(e),
  });
  return { result, events };
}

const withFeatures = (extra: Partial<CovselConfig> = {}): CovselConfig =>
  resolveConfig({ testGlobs: ['**/*.feature'], ...extra });

describe('cucumber recorder source-map configuration', () => {
  it('fails the recording when an unmappable script was not accepted', async () => {
    const { result } = await record(fixture(), withFeatures());

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toContain('dist/widget.mjs');
  }, 180_000);

  it('records when the project accepted that script, and names what it let through', async () => {
    const config = withFeatures({
      sourceMaps: { buildDirs: [], http: true, allowUnmappable: ['dist/widget.mjs'] },
    });

    const { result, events } = await record(fixture(), config);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    const recorded = events.filter((e) => e.kind === 'recorded');
    expect(recorded[0]?.allowedUnmappable).toEqual(['dist/widget.mjs']);
    expect(result.map?.entries[0]?.files.map((f) => f.file)).toContain('src/app.mjs');
  }, 180_000);
});
