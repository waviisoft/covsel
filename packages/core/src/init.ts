import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { findConfigFile, loadConfig } from './config.js';

/**
 * Project bootstrap: work out which adapter records this project, persist that
 * choice, and keep the map out of version control.
 *
 * covsel ships no adapters — each is a package the project installs — so the
 * first question in adopting it is which package that is, and the answer comes
 * from a runner the project already declares. Detection reads it off
 * `package.json` and writes the name down once, so later commands need no
 * `--adapter`.
 *
 * What this deliberately does not do is guess. A runner covsel has no signature
 * for is reported, with what an adapter request needs, rather than resolved to
 * the generic wrap on the theory that something is better than nothing. Whether
 * a given recording could actually see a project's sources is settled by the
 * recording itself — a change to a file outside what the map observed falls
 * open — so there is nothing to be gained here by predicting it, and a wrong
 * prediction would only push someone away from an adapter that works.
 */

const ISSUES_URL = 'https://github.com/waviisoft/covsel/issues';

interface RunnerSignature {
  /** How the runner is known to its users. */
  name: string;
  /** The `--adapter` name that records it, or undefined when none exists yet. */
  adapter?: string;
  /** Package names that identify the runner. */
  deps: readonly string[];
  /** Test-script fragments that identify the runner. */
  scripts: readonly RegExp[];
  /** The command `record` and `run` should wrap, for the printed next steps. */
  command?: string;
}

/**
 * Runners covsel can name, and the adapter for each. Anything absent is
 * reported as undetected rather than guessed at.
 */
const RUNNERS: readonly RunnerSignature[] = [
  {
    name: 'vitest',
    adapter: 'vitest',
    deps: ['vitest'],
    scripts: [/\bvitest\b/],
    command: 'vitest run',
  },
  {
    name: 'jest',
    adapter: 'jest',
    deps: ['jest', 'jest-cli', 'ts-jest', '@jest/core'],
    scripts: [/\bjest\b/],
    command: 'jest',
  },
  {
    name: 'cucumber-js',
    adapter: 'cucumber',
    deps: ['@cucumber/cucumber'],
    scripts: [/\bcucumber-js\b/],
    command: 'cucumber-js',
  },
  {
    name: 'node:test',
    adapter: 'node-test',
    deps: [],
    scripts: [/\bnode\b[^&|;]*--test\b/, /\bnode:test\b/],
    command: 'node --test',
  },
  {
    name: 'mocha',
    adapter: 'generic',
    deps: ['mocha'],
    scripts: [/\bmocha\b/],
    command: 'mocha',
  },
  { name: 'playwright', deps: ['@playwright/test'], scripts: [/\bplaywright\b/] },
];

/** Dependency names worth naming in a bug report. */
const TEST_RELATED =
  /test|spec|jest|mocha|vitest|cucumber|playwright|ava|tap|karma|jasmine|cypress/i;

/** A runner covsel recognised in the project. */
export interface DetectedRunner {
  name: string;
  /** The `--adapter` name that records it, or undefined when none exists yet. */
  adapter?: string;
  /** Why covsel believes this runner is in use. */
  evidence: string;
  /** The command covsel would wrap to record it. */
  command?: string;
}

/**
 * Environment for a bug report. Everything here is either safe by construction
 * (versions, platform) or shown locally for the user to review before sharing —
 * `testScript` is the project's own text and never travels in a prefilled URL.
 */
export interface InitDiagnostics {
  covselVersion: string;
  nodeVersion: string;
  platform: string;
  packageManager: string;
  testScript?: string;
  /** Names only of dependencies that look test-related. */
  dependencies: string[];
}

export type InitOutcome =
  /** A config was written. */
  | 'configured'
  /** A config already existed and was left alone. */
  | 'already-configured'
  /** A runner covsel knows, but no adapter records it yet. */
  | 'unsupported-runner'
  /** No runner covsel recognises. */
  | 'undetected';

export interface InitResult {
  outcome: InitOutcome;
  /** The persisted adapter name, when one was written or already configured. */
  adapter?: string;
  /** Whether that adapter's package is installed, when the caller could check. */
  adapterInstalled?: boolean;
  /** Where the config lives (or would live). */
  configPath: string;
  configWritten: boolean;
  gitignorePath: string;
  gitignoreUpdated: boolean;
  detected: DetectedRunner[];
  warnings: string[];
  diagnostics: InitDiagnostics;
  /** The commands to run next, when the project is configured. */
  commands?: { record: string; affected: string; run: string };
  /** Where to report a runner covsel could not configure. */
  reportUrl?: string;
}

export interface InitOptions {
  cwd: string;
  /** The covsel version, for the diagnostic block. */
  covselVersion: string;
  /** An explicit adapter name from the caller, used instead of detection. */
  adapter?: string;
  /**
   * Whether an adapter package is installed. Resolving a name to a package is
   * the consumer's job — the CLI knows the specifiers and the resolution rules —
   * so init asks rather than guesses, and simply reports less when it cannot.
   */
  isAdapterInstalled?: (name: string) => Promise<boolean>;
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

function readPackageJson(cwd: string): PackageJson | undefined {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return undefined;
  }
}

function detectPackageManager(cwd: string, pkg: PackageJson | undefined): string {
  const declared = pkg?.packageManager;
  if (declared !== undefined && declared !== '') return declared;
  for (const [lockfile, name] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
    ['bun.lockb', 'bun'],
  ] as const) {
    if (existsSync(join(cwd, lockfile))) return name;
  }
  return 'unknown';
}

/** Every runner covsel can name in this project, ones it can record first. */
export function detectRunners(cwd: string): DetectedRunner[] {
  const pkg = readPackageJson(cwd);
  if (!pkg) return [];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const testScript = pkg.scripts?.test;

  const found: DetectedRunner[] = [];
  for (const runner of RUNNERS) {
    const dep = runner.deps.find((d) => d in deps);
    const evidence =
      dep !== undefined
        ? `${dep} is a dependency`
        : testScript !== undefined && runner.scripts.some((s) => s.test(testScript))
          ? 'the test script invokes it'
          : undefined;
    if (evidence === undefined) continue;
    found.push({
      name: runner.name,
      ...(runner.adapter !== undefined ? { adapter: runner.adapter } : {}),
      ...(runner.command !== undefined ? { command: runner.command } : {}),
      evidence,
    });
  }
  return found;
}

function ensureGitignored(cwd: string, storeDir: string): boolean {
  const path = join(cwd, '.gitignore');
  const entry = `${storeDir.replace(/\/+$/, '')}/`;
  const bare = entry.slice(0, -1);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;

  if (existing === undefined) {
    writeFileSync(path, `${entry}\n`);
    return true;
  }
  const present = existing
    .split('\n')
    .map((line) => line.trim().replace(/^\//, ''))
    .some((line) => line === entry || line === bare);
  if (present) return false;
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${existing}${separator}${entry}\n`);
  return true;
}

function nextCommands(
  adapter: string,
  runner: DetectedRunner | undefined,
): { record: string; affected: string; run: string } {
  const command = runner?.command ?? '<your test command>';
  return {
    record: `covsel record --adapter ${adapter} -- ${command}`,
    affected: 'covsel affected',
    run: `covsel run --adapter ${adapter} -- ${command}`,
  };
}

function adapterRequestUrl(diagnostics: InitDiagnostics): string {
  const params = new URLSearchParams({
    template: 'adapter_request.yml',
    // Safe by construction: versions and platform only. The project's own
    // strings stay in the printed block for the user to review.
    notes: [
      `covsel ${diagnostics.covselVersion}`,
      `Node ${diagnostics.nodeVersion}`,
      diagnostics.platform,
      `package manager: ${diagnostics.packageManager}`,
    ].join(' · '),
  });
  return `${ISSUES_URL}/new?${params.toString()}`;
}

function existingIssuesUrl(runner: string): string {
  return `${ISSUES_URL}?${new URLSearchParams({ q: `is:issue ${runner}` }).toString()}`;
}

/**
 * Configure covsel for a project: detect the runner, persist the adapter name,
 * and ignore the map directory. Writes nothing when it cannot name an adapter,
 * so a project is never left with a config pointing at a runner covsel does not
 * record.
 */
export async function initProject(options: InitOptions): Promise<InitResult> {
  const { cwd, covselVersion } = options;
  const pkg = readPackageJson(cwd);
  const testScript = pkg?.scripts?.test;
  const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });

  const diagnostics: InitDiagnostics = {
    covselVersion,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    packageManager: detectPackageManager(cwd, pkg),
    ...(testScript !== undefined ? { testScript } : {}),
    dependencies: deps.filter((d) => TEST_RELATED.test(d)),
  };

  const detected = detectRunners(cwd);
  const supported = detected.find((r) => r.adapter !== undefined);
  const base = {
    configPath: join(cwd, '.covsel.json'),
    configWritten: false,
    gitignorePath: join(cwd, '.gitignore'),
    gitignoreUpdated: false,
    detected,
    warnings: [] as string[],
    diagnostics,
  };

  const installed = async (name: string): Promise<{ adapterInstalled?: boolean }> => {
    if (options.isAdapterInstalled === undefined) return {};
    return { adapterInstalled: await options.isAdapterInstalled(name) };
  };

  // An existing config is the project's decision of record; init only makes
  // sure the store stays out of version control.
  const existing = findConfigFile(cwd);
  const config = await loadConfig(cwd);
  if (existing !== undefined) {
    // Report what the config actually says, never what detection would have
    // chosen — "already configured as X" has to be true of the file on disk.
    const named = config.adapter;
    return {
      ...base,
      outcome: 'already-configured',
      ...(named !== undefined ? { adapter: named, ...(await installed(named)) } : {}),
      warnings:
        named === undefined && supported !== undefined
          ? [
              `${existing} names no adapter, so commands fall back to the default; ` +
                `add "adapter": "${supported.adapter}" to record ${supported.name} with.`,
            ]
          : [],
      configPath: existing,
      gitignoreUpdated: ensureGitignored(cwd, config.store.dir),
      ...(named !== undefined
        ? { commands: nextCommands(named, supported ?? detected[0]) }
        : {}),
    };
  }

  const adapter = options.adapter ?? supported?.adapter;
  if (adapter === undefined) {
    const unsupported = detected[0];
    return {
      ...base,
      outcome: unsupported ? 'unsupported-runner' : 'undetected',
      reportUrl: unsupported
        ? existingIssuesUrl(unsupported.name)
        : adapterRequestUrl(diagnostics),
    };
  }

  // A repo often runs several suites — Vitest for units, Playwright for E2E.
  // Configuring the one covsel can record says nothing about the others, so
  // name them rather than let their silence read as coverage.
  const warnings = detected
    .filter((r) => r.adapter === undefined)
    .map((r) => `${r.name} has no adapter yet; keep running that suite in full.`);
  if (adapter === 'vitest' && !deps.includes('@vitest/coverage-v8')) {
    warnings.push(
      'install @vitest/coverage-v8 before recording — the Vitest adapter records ' +
        "through Vitest's own coverage provider.",
    );
  }

  writeFileSync(base.configPath, `${JSON.stringify({ adapter }, null, 2)}\n`);

  return {
    ...base,
    outcome: 'configured',
    adapter,
    ...(await installed(adapter)),
    configWritten: true,
    warnings,
    gitignoreUpdated: ensureGitignored(cwd, config.store.dir),
    commands: nextCommands(adapter, supported ?? detected[0]),
  };
}
