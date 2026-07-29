import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  applyInit,
  type InitPlan,
  installCommand,
  loadConfig,
  planInit,
} from '../src/index.js';

/**
 * `covsel init` answers the first question in adopting covsel — which adapter
 * package records this project — from a runner the project already declares.
 * The tests that matter most are the ones asserting it never answers that
 * question by guessing: a config naming an adapter that cannot record the
 * runner is worse than no config, because it looks settled.
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

const plan = (cwd: string, adapter?: string): Promise<InitPlan> =>
  planInit({ cwd, covselVersion: VERSION, ...(adapter ? { adapter } : {}) });

/** Plan and carry it out, the way `covsel init` does once confirmed. */
async function init(cwd: string, adapter?: string) {
  const p = await plan(cwd, adapter);
  const applied = await applyInit(cwd, p);
  return { ...p, ...applied };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('covsel init — naming the adapter', () => {
  it.each([
    ['vitest', { devDependencies: { vitest: '^3.0.0' } }, 'vitest run'],
    ['jest', { devDependencies: { jest: '^29.0.0' } }, 'jest'],
    ['cucumber', { devDependencies: { '@cucumber/cucumber': '^11.0.0' } }, 'cucumber-js'],
    ['node-test', { scripts: { test: 'node --test' } }, 'node --test'],
    ['generic', { devDependencies: { mocha: '^10.0.0' } }, 'mocha'],
  ])('names %s and writes it to the config', async (adapter, fields, command) => {
    const cwd = project({ 'package.json': pkg(fields) });

    const result = await init(cwd);

    expect(result.outcome).toBe('configure');
    expect(result.adapter).toBe(adapter);
    expect(JSON.parse(readFileSync(join(cwd, 'covsel.json'), 'utf8'))).toEqual({
      adapter,
    });
    expect((await loadConfig(cwd)).adapter).toBe(adapter);
    expect(result.commands?.record).toBe(
      `covsel record --adapter ${adapter} -- ${command}`,
    );
  });

  it('reports whether the adapter package is installed', async () => {
    const cwd = project({ 'package.json': pkg({ devDependencies: { vitest: '^3' } }) });

    const missing = await planInit({
      cwd,
      covselVersion: VERSION,
      isAdapterInstalled: () => Promise.resolve(false),
    });

    expect(missing.adapter).toBe('vitest');
    expect(missing.adapterInstalled).toBe(false);
  });

  it('leaves installedness unknown when the caller cannot check', async () => {
    const cwd = project({ 'package.json': pkg({ devDependencies: { vitest: '^3' } }) });

    expect((await init(cwd)).adapterInstalled).toBeUndefined();
  });

  it('plans to install what recording needs beyond the adapter', async () => {
    const without = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });
    const with_ = project({
      'package.json': pkg({
        devDependencies: { vitest: '^3.0.0', '@vitest/coverage-v8': '^3.0.0' },
      }),
    });

    // The Vitest adapter records through Vitest's own coverage provider, so
    // installing the adapter alone would leave recording broken.
    expect((await plan(without)).missingSupport).toEqual(['@vitest/coverage-v8']);
    expect((await plan(with_)).missingSupport).toEqual([]);
  });

  it('plans no support packages for a runner that needs none', async () => {
    const cwd = project({ 'package.json': pkg({ devDependencies: { jest: '^29' } }) });

    expect((await plan(cwd)).missingSupport).toEqual([]);
  });

  it('keys support packages on the chosen adapter, not the detected runner', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });

    // Overriding onto the generic wrap means not recording through Vitest's
    // coverage provider, so installing it would be noise.
    expect((await plan(cwd, 'generic')).missingSupport).toEqual([]);
  });

  it('names the other suites it cannot record', async () => {
    const cwd = project({
      'package.json': pkg({
        devDependencies: { vitest: '^3.0.0', '@playwright/test': '^1.0.0' },
      }),
    });

    const result = await init(cwd);

    expect(result.adapter).toBe('vitest');
    expect(result.warnings.join('\n')).toContain('playwright has no adapter yet');
  });

  it('adds the store directory to .gitignore', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
      '.gitignore': 'node_modules/\n',
    });

    expect((await init(cwd)).gitignoreUpdated).toBe(true);
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

describe('covsel init — what it will not guess', () => {
  it('writes nothing for a runner no adapter records', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { '@playwright/test': '^1.0.0' } }),
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('unsupported-runner');
    expect(result.configWritten).toBe(false);
    expect(result.gitignoreUpdated).toBe(false);
    expect(result.detected.map((r: { name: string }) => r.name)).toContain('playwright');
    expect(result.reportUrl).toContain('playwright');
  });

  it('writes nothing when it recognises no runner at all', async () => {
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
});

describe('covsel init — planning is not doing', () => {
  it('touches nothing while planning', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });

    const planned = await plan(cwd);

    expect(planned.needsConfig).toBe(true);
    expect(planned.needsGitignore).toBe(true);
    expect(existsSync(join(cwd, 'covsel.json'))).toBe(false);
    expect(existsSync(join(cwd, '.gitignore'))).toBe(false);
  });

  it('is inert when applied to a plan that configures nothing', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }),
    });

    const applied = await applyInit(cwd, await plan(cwd));

    expect(applied).toEqual({ configWritten: false, gitignoreUpdated: false });
    expect(existsSync(join(cwd, 'covsel.json'))).toBe(false);
    expect(existsSync(join(cwd, '.gitignore'))).toBe(false);
  });

  it('still ignores the map for a project configured before that was habit', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
      'covsel.json': `${JSON.stringify({ adapter: 'vitest' })}\n`,
    });

    const applied = await applyInit(cwd, await plan(cwd));

    expect(applied.configWritten).toBe(false);
    expect(applied.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain('.covsel/');
  });
});

describe('covsel init — installing', () => {
  it.each([
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['npm', 'package-lock.json'],
    ['bun', 'bun.lockb'],
  ])('detects %s from its lockfile', async (manager, lockfile) => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
      [lockfile]: '',
    });

    expect((await plan(cwd)).packageManager).toBe(manager);
  });

  it('prefers a declared packageManager over the lockfile', async () => {
    const cwd = project({
      'package.json': pkg({
        packageManager: 'pnpm@11.15.1',
        devDependencies: { vitest: '^3.0.0' },
      }),
      'package-lock.json': '',
    });

    expect((await plan(cwd)).packageManager).toBe('pnpm');
  });

  it('falls back to npm when nothing says otherwise', async () => {
    const cwd = project({ 'package.json': pkg({ devDependencies: { vitest: '^3' } }) });

    expect((await plan(cwd)).packageManager).toBe('npm');
  });

  it.each([
    ['npm', ['npm', 'install', '--save-dev', 'a', 'b']],
    ['pnpm', ['pnpm', 'add', '--save-dev', 'a', 'b']],
    ['yarn', ['yarn', 'add', '--dev', 'a', 'b']],
    ['bun', ['bun', 'add', '--dev', 'a', 'b']],
  ])('builds the %s install command', (manager, expected) => {
    expect(installCommand(manager, ['a', 'b'])).toEqual(expected);
  });

  it('installs with npm when the manager is unrecognised', () => {
    expect(installCommand('frobnicate', ['a'])[1]).toBe('install');
  });
});

describe('covsel init — overrides', () => {
  it('honors an explicit adapter when detection finds nothing', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { ava: '^6.0.0' } }),
    });

    const result = await init(cwd, 'ava');

    expect(result.outcome).toBe('configure');
    expect(result.adapter).toBe('ava');
    expect((await loadConfig(cwd)).adapter).toBe('ava');
  });

  it('honors an explicit adapter over a detected one', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });

    expect((await init(cwd, 'generic')).adapter).toBe('generic');
  });
});

describe('covsel init — idempotence', () => {
  it('leaves an existing config byte-identical', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
    });
    await init(cwd);
    const before = readFileSync(join(cwd, 'covsel.json'), 'utf8');

    const second = await init(cwd);

    expect(second.outcome).toBe('already-configured');
    expect(second.configWritten).toBe(false);
    expect(readFileSync(join(cwd, 'covsel.json'), 'utf8')).toBe(before);
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
      'covsel.json': `${JSON.stringify({ store: { dir: '.cache/covsel' } })}\n`,
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
    expect(result.adapter).toBe('vitest');
    expect(result.configPath).toContain('covsel.config.js');
  });

  it('reports what an existing config says, not what detection would pick', async () => {
    const cwd = project({
      'package.json': pkg({ devDependencies: { vitest: '^3.0.0' } }),
      'covsel.json': `${JSON.stringify({ granularity: 'file' })}\n`,
    });

    const result = await init(cwd);

    expect(result.outcome).toBe('already-configured');
    expect(result.adapter).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('names no adapter');
    expect(result.warnings.join('\n')).toContain('"adapter": "vitest"');
    expect(readFileSync(join(cwd, 'covsel.json'), 'utf8')).not.toContain('adapter');
  });
});
