import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

import { createNodeTestRecorder } from '../src/index.js';

/**
 * The per-test recorder runs its mapper in a spawned shim, so every mapping
 * decision the project configured has to survive the process boundary. The one
 * with observable consequences is `sourceMaps.allowUnmappable`: a script that
 * resolves to no source fails the recording, and a project that has accepted
 * that gap must be able to record anyway. If the configuration does not reach
 * the shim, the accommodation silently does not exist and such a project cannot
 * record at all — the failure is safe but total, and nothing says why.
 *
 * The fixture is the shape that produces it: a test that reaches its code
 * through a build with no source map, which covsel reads as build output
 * because it sits under `dist/`.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));

const FILES: Record<string, string> = {
  'src/app.mjs': 'export function greet(n) {\n  return `hi ${n}`;\n}\n',
  // No `sourceMappingURL`: the build published no map, so nothing traces this
  // back to a source anyone wrote.
  'dist/widget.mjs': 'export function badge(s) {\n  return `[${s}]`;\n}\n',
  'suite.test.mjs': [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './src/app.mjs';",
    "import { badge } from './dist/widget.mjs';",
    "test('greets through the widget', () => {",
    "  assert.equal(badge(greet('x')), '[hi x]');",
    '});',
    '',
  ].join('\n'),
  'package.json': '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
  '.gitignore': '.covsel/\n',
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
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-nodetest-maps-'));
  dirs.push(cwd);
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(cwd, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  for (const args of [
    ['init', '-q'],
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
  const recorder = createNodeTestRecorder({ command: ['node', '--test'], cwd, config });
  const events: RecordEvent[] = [];
  const result = await recordMap({
    cwd,
    config,
    recorder,
    onEvent: (e) => events.push(e),
  });
  return { result, events };
}

describe('node:test recorder source-map configuration', () => {
  it('fails the recording when an unmappable script was not accepted', async () => {
    const { result } = await record(fixture(), resolveConfig());

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toContain('dist/widget.mjs');
  }, 120_000);

  it('records when the project accepted that script, and names what it let through', async () => {
    const config = resolveConfig({
      sourceMaps: { allowUnmappable: ['dist/widget.mjs'] },
    });

    const { result, events } = await record(fixture(), config);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    const recorded = events.filter((e) => e.kind === 'recorded');
    expect(recorded[0]?.allowedUnmappable).toEqual(['dist/widget.mjs']);
    // The rest of the recording is unaffected: the source the test also
    // executed is still credited to it.
    expect(result.map?.entries[0]?.files.map((f) => f.file)).toContain('src/app.mjs');
  }, 120_000);

  it('accepts only the scripts listed, not every unmappable one', async () => {
    const config = resolveConfig({
      sourceMaps: { allowUnmappable: ['dist/something-else.mjs'] },
    });

    const { result } = await record(fixture(), config);

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toContain('dist/widget.mjs');
  }, 120_000);
});
