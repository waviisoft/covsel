import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { initProject, loadConfig } from '../src/index.js';

/**
 * `covsel init` decides one thing — which adapter records this project — and
 * persists it. The tests that matter most are the ones asserting it refuses to
 * persist a fail-closed setup: a runner that transforms sources before
 * executing them records a map in which no test covers `src/**`, so a diff
 * touching app source would select nothing at all.
 */

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'covsel-init-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function pkg(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ name: 'fixture', private: true, ...fields }, null, 2)}\n`;
}

const VERSION = '9.9.9';
const init = (cwd: string, adapter?: string) =>
  initProject({ cwd, covselVersion: VERSION, ...(adapter ? { adapter } : {}) });

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('covsel init — detection', () => {
  it('configures a Vitest project for the Vitest adapter', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('configured');
    expect(result.adapter).toBe('vitest');
    expect(result.configWritten).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, '.covsel.json'), 'utf8'))).toEqual({
      adapter: 'vitest',
    });
    expect((await loadConfig(cwd)).adapter).toBe('vitest');
    expect(result.commands?.record).toContain('--adapter vitest');
  });

  it('warns when a Vitest project lacks the coverage provider', async () => {
    const without = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });
    const with_ = project({
      'package.json': pkg({
        devDependencies: { vitest: '^3.0.0', '@vitest/coverage-v8': '^3.0.0' },
      }),
    });

    const missing = await init(without);
    const present = await init(with_);

    expect(missing.warnings.join('\n')).toContain('@vitest/coverage-v8');
    expect(present.warnings.join('\n')).not.toContain('@vitest/coverage-v8');
    expect(missing.outcome).toBe('configured');
  });

  it('configures a node:test project from its test script', async () => {
    const cwd = project({
      'package.json': pkg({ scripts: { test: 'node --test' } }),
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('configured');
    expect(result.adapter).toBe('node-test');
    expect(result.commands?.record).toContain('node --test');
  });

  it('configures Mocha on plain JS for the generic adapter', async () => {
    const cwd = project({
      'package.json': pkg({
        devDependencies: { mocha: '^10.0.0' },
        scripts: { test: 'mocha' },
      }),
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('configured');
    expect(result.adapter).toBe('generic');
    expect(result.commands?.record).not.toContain('--adapter');
  });

  it('adds the store directory to .gitignore', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
      '.gitignore': 'node_modules/\n',
    });

    const result = await init(cwd);

    expect(result.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain('.covsel/');
  });

  it('creates .gitignore when the project has none', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });

    await init(cwd);

    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain('.covsel/');
  });
});

describe('covsel init — never persists a fail-closed setup', () => {
  it('refuses to auto-configure a known transforming runner', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { jest: '^29.0.0' } }),
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('unsupported-runner');
    expect(result.configWritten).toBe(false);
    expect(result.detected.map((r) => r.name)).toContain('jest');
    expect(result.detected.every((r) => r.adapter === undefined)).toBe(true);
  });

  it.each([
    ['ts-node', 'mocha --require ts-node/register'],
    ['tsx', 'node --import tsx --test'],
    ['babel', 'mocha --require @babel/register'],
  ])('refuses when the test command transforms sources via %s', async (_, script) => {
    const cwd = project({
      'package.json': pkg({
        devDependencies: { mocha: '^10.0.0' },
        scripts: { test: script },
      }),
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('unsupported-runner');
    expect(result.configWritten).toBe(false);
  });

  it('still configures Vitest when its command transforms sources', async () => {
    // The Vitest adapter records through Vitest's own coverage provider, so
    // transformation is expected rather than disqualifying.
    const cwd = project({
      'package.json': pkg({
        devDependencies: { vitest: '^3.0.0' },
        scripts: { test: 'vitest run' },
      }),
    });

    expect((await init(cwd)).outcome).toBe('configured');
  });

  it('names the other suites it cannot observe', async () => {
    const cwd = project({
      'package.json': pkg({
        devDependencies: { vitest: '^3.0.0', '@playwright/test': '^1.0.0' },
      }),
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('configured');
    expect(result.adapter).toBe('vitest');
    expect(result.warnings.join('\n')).toContain('playwright has no adapter yet');
  });

  it('warns about under-selection when overridden onto a transforming runner', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { jest: '^29.0.0' } }),
    });

    const result = await init(cwd, 'generic');

    expect(result.outcome).toBe('configured');
    expect(result.adapter).toBe('generic');
    expect(result.warnings.join('\n')).toMatch(/under-select/i);
    expect(result.warnings.join('\n')).toMatch(/fail-open/i);
  });
});

describe('covsel init — detection misses', () => {
  it('reports an undetected runner without writing anything', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }),
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('undetected');
    expect(result.configWritten).toBe(false);
    expect(result.gitignoreUpdated).toBe(false);
    expect(result.reportUrl).toContain('adapter_request.yml');
  });

  it('reports a project with no package.json', async () => {
    const result = await init(project({}));

    expect(result.outcome).toBe('undetected');
    expect(result.configWritten).toBe(false);
  });

  it('carries the environment a bug report needs', async () => {
    const cwd = project({
      'package.json': pkg({
        devDependencies: { ava: '^6.0.0' },
        scripts: { test: 'ava --serial' },
      }),
    });

    const { diagnostics } = await init(cwd);

    expect(diagnostics.covselVersion).toBe(VERSION);
    expect(diagnostics.nodeVersion).toBe(process.version);
    expect(diagnostics.platform).toContain(process.platform);
    expect(diagnostics.testScript).toBe('ava --serial');
    expect(diagnostics.dependencies).toContain('ava');
  });

  it('keeps repository content out of the prefilled report URL', async () => {
    const cwd = project({
      'package.json': pkg({
        devDependencies: { ava: '^6.0.0' },
        scripts: { test: 'SECRET_TOKEN=hunter2 ava' },
      }),
    });

    const { reportUrl = '' } = await init(cwd);

    expect(reportUrl).not.toContain('hunter2');
    expect(reportUrl).not.toContain(encodeURIComponent('hunter2'));
    expect(reportUrl).not.toContain(cwd);
    expect(reportUrl).not.toContain(encodeURIComponent(cwd));
  });

  it('points a known unsupported runner at the existing issue search', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { jest: '^29.0.0' } }),
    });

    const { reportUrl = '' } = await init(cwd);

    expect(reportUrl).toContain('jest');
    expect(reportUrl).not.toContain('adapter_request.yml');
  });
});

describe('covsel init — overrides', () => {
  it('honors an explicit adapter when detection finds nothing', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }),
    });

    const result = await init(cwd, 'generic');

    expect(result.outcome).toBe('configured');
    expect(result.adapter).toBe('generic');
    expect((await loadConfig(cwd)).adapter).toBe('generic');
  });

  it('rejects an unknown adapter name without writing anything', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });

    const result = await init(cwd, 'nope');

    expect(result.outcome).toBe('unknown-adapter');
    expect(result.configWritten).toBe(false);
    expect(result.warnings.join('\n')).toContain('generic');
    expect(result.warnings.join('\n')).toContain('vitest');
    expect(result.warnings.join('\n')).toContain('node-test');
  });
});

describe('covsel init — idempotence', () => {
  it('leaves an existing config byte-identical', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });
    await init(cwd);
    const before = readFileSync(join(cwd, '.covsel.json'), 'utf8');

    const second = await init(cwd);

    expect(second.outcome).toBe('already-configured');
    expect(second.configWritten).toBe(false);
    expect(readFileSync(join(cwd, '.covsel.json'), 'utf8')).toBe(before);
  });

  it('never duplicates the .gitignore entry', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
      '.gitignore': '.covsel/\n',
    });

    const first = await init(cwd);
    await init(cwd);

    expect(first.gitignoreUpdated).toBe(false);
    const lines = readFileSync(join(cwd, '.gitignore'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '.covsel/');
    expect(lines).toHaveLength(1);
  });

  it('honors a non-default store directory when ignoring the map', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
      '.covsel.json': `${JSON.stringify({ store: { dir: '.cache/covsel' } })}\n`,
    });

    await init(cwd);

    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain('.cache/covsel/');
  });

  it('recognises an existing config under any supported filename', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
      'covsel.config.js': 'export default { adapter: "vitest" };\n',
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('already-configured');
    expect(result.configPath).toContain('covsel.config.js');
  });
});
