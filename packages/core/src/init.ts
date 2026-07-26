import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ADAPTERS,
  type AdapterName,
  findConfigFile,
  isAdapterName,
  loadConfig,
} from './config.js';

/**
 * Project bootstrap: work out which recorder observes this project, persist
 * that decision, and keep the map out of version control.
 *
 * The adapter choice is the one consequential decision in adopting covsel, and
 * it turns on something invisible from the outside — whether the runner
 * executes your sources or transformed copies of them. Get it wrong for a
 * transforming runner and coverage shows no test covering your sources, so a
 * diff touching them selects *nothing*: the fail-closed outcome covsel exists
 * to prevent. So detection never resolves a transforming runner to a recorder
 * that cannot see through the transform. It reports instead, and a caller who
 * knows better can override — loudly, never silently.
 */

const ISSUES_URL = 'https://github.com/waviisoft/covsel/issues';

interface RunnerSignature {
  name: string;
  /** The recorder for this runner, or undefined when none exists yet. */
  adapter?: AdapterName;
  /** Package names that identify the runner. */
  deps: readonly string[];
  /** Test-script fragments that identify the runner. */
  scripts: readonly RegExp[];
  /**
   * True when the runner hands transformed sources to the engine and the
   * adapter reads the runner's own coverage rather than the process's — so a
   * transforming test command is expected, not disqualifying.
   */
  readsOwnCoverage?: boolean;
}

/**
 * Runners covsel can name. Anything absent is reported as undetected rather
 * than guessed at: a wrong guess here is a fail-closed map.
 */
const RUNNERS: readonly RunnerSignature[] = [
  {
    name: 'vitest',
    adapter: 'vitest',
    deps: ['vitest'],
    scripts: [/\bvitest\b/],
    readsOwnCoverage: true,
  },
  {
    name: 'node:test',
    adapter: 'node-test',
    deps: [],
    scripts: [/\bnode\b[^&|;]*--test\b/, /\bnode:test\b/],
  },
  { name: 'mocha', adapter: 'generic', deps: ['mocha'], scripts: [/\bmocha\b/] },
  {
    name: 'jest',
    deps: ['jest', 'jest-cli', 'ts-jest', '@jest/core'],
    scripts: [/\bjest\b/],
  },
  {
    name: 'cucumber-js',
    deps: ['@cucumber/cucumber'],
    scripts: [/\bcucumber-js\b/],
  },
  {
    name: 'playwright',
    deps: ['@playwright/test'],
    scripts: [/\bplaywright\b/],
  },
];

/**
 * Loaders and register hooks that compile sources on the way to the engine.
 * Under one of these, process coverage sees the compiled output and attributes
 * nothing back to `src/**`.
 */
const TRANSFORM_MARKERS: readonly RegExp[] = [
  /\bts-node\b/,
  /\btsx\b/,
  /@swc\/register|\bswc-node\b/,
  /@babel\/register|\bbabel-register\b/,
  /\besbuild-register\b/,
];

/** The canonical recording command per adapter, for the printed next steps. */
const RUNNER_COMMANDS: Record<string, string> = {
  vitest: 'vitest run',
  'node:test': 'node --test',
  mocha: 'mocha',
};

/** A runner covsel recognised in the project. */
export interface DetectedRunner {
  name: string;
  /** The recorder for this runner, or undefined when none exists yet. */
  adapter?: AdapterName;
  /** Why covsel believes this runner is in use. */
  evidence: string;
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
  /** A runner covsel knows, but has no recorder that can observe it. */
  | 'unsupported-runner'
  /** No runner covsel recognises. */
  | 'undetected'
  /** The caller asked for an adapter that does not exist. */
  | 'unknown-adapter';

export interface InitResult {
  outcome: InitOutcome;
  /** The persisted adapter, when one was written or already configured. */
  adapter?: AdapterName;
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
  /** An explicit adapter from the caller, unvalidated. */
  adapter?: string;
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

/** True when the test command compiles sources before the engine sees them. */
export function transformsSources(testScript: string | undefined): boolean {
  if (testScript === undefined) return false;
  return TRANSFORM_MARKERS.some((marker) => marker.test(testScript));
}

/** Every runner covsel can name in this project, most specific evidence first. */
export function detectRunners(cwd: string): DetectedRunner[] {
  const pkg = readPackageJson(cwd);
  if (!pkg) return [];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const testScript = pkg.scripts?.test;

  const found: DetectedRunner[] = [];
  for (const runner of RUNNERS) {
    const dep = runner.deps.find((d) => d in deps);
    if (dep !== undefined) {
      found.push({
        name: runner.name,
        ...(runner.adapter ? { adapter: runner.adapter } : {}),
        evidence: `${dep} is a dependency`,
      });
      continue;
    }
    if (testScript !== undefined && runner.scripts.some((s) => s.test(testScript))) {
      found.push({
        name: runner.name,
        ...(runner.adapter ? { adapter: runner.adapter } : {}),
        evidence: 'the test script invokes it',
      });
    }
  }

  // A runner whose recorder reads process coverage cannot see through a
  // transform hook, so drop the adapter and let init report it rather than
  // persist a map that would select nothing.
  if (!transformsSources(testScript)) return found;
  return found.map((runner) => {
    const signature = RUNNERS.find((r) => r.name === runner.name);
    if (signature?.readsOwnCoverage === true || runner.adapter === undefined) {
      return runner;
    }
    return {
      name: runner.name,
      evidence: `${runner.evidence}, under a source transform`,
    };
  });
}

function gitignoreEntry(storeDir: string): string {
  return `${storeDir.replace(/\/+$/, '')}/`;
}

function ensureGitignored(cwd: string, storeDir: string): boolean {
  const path = join(cwd, '.gitignore');
  const entry = gitignoreEntry(storeDir);
  const bare = entry.slice(0, -1);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;

  if (existing !== undefined) {
    const present = existing
      .split('\n')
      .map((line) => line.trim().replace(/^\//, ''))
      .some((line) => line === entry || line === bare);
    if (present) return false;
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
    writeFileSync(path, `${existing}${separator}${entry}\n`);
    return true;
  }

  writeFileSync(path, `${entry}\n`);
  return true;
}

function nextCommands(
  adapter: AdapterName,
  runner: DetectedRunner | undefined,
): { record: string; affected: string; run: string } {
  const command =
    (runner ? RUNNER_COMMANDS[runner.name] : undefined) ?? '<your test command>';
  const flag = adapter === 'generic' ? '' : ` --adapter ${adapter}`;
  return {
    record: `covsel record${flag} -- ${command}`,
    affected: 'covsel affected',
    run: `covsel run${flag} -- ${command}`,
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
 * Configure covsel for a project: detect the runner, persist the adapter, and
 * ignore the map directory. Writes nothing when it cannot determine a recorder
 * that would produce a trustworthy map.
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
    dependencies: deps.filter((d) =>
      /test|spec|jest|mocha|vitest|cucumber|playwright|ava|tap|karma|jasmine/i.test(d),
    ),
  };

  const base = {
    configPath: join(cwd, '.covsel.json'),
    configWritten: false,
    gitignorePath: join(cwd, '.gitignore'),
    gitignoreUpdated: false,
    detected: [] as DetectedRunner[],
    warnings: [] as string[],
    diagnostics,
  };

  if (options.adapter !== undefined && !isAdapterName(options.adapter)) {
    return {
      ...base,
      outcome: 'unknown-adapter',
      warnings: [
        `unknown adapter '${options.adapter}' — expected one of ${ADAPTERS.join(', ')}`,
      ],
    };
  }
  const override = options.adapter as AdapterName | undefined;

  const detected = detectRunners(cwd);
  const existing = findConfigFile(cwd);
  const config = await loadConfig(cwd);

  // An existing config is the project's decision of record; init only makes
  // sure the store stays out of version control.
  if (existing !== undefined) {
    return {
      ...base,
      outcome: 'already-configured',
      adapter: config.adapter,
      configPath: existing,
      detected,
      gitignoreUpdated: ensureGitignored(cwd, config.store.dir),
      commands: nextCommands(
        config.adapter,
        detected.find((r) => r.adapter !== undefined) ?? detected[0],
      ),
    };
  }

  const supported = detected.find((r) => r.adapter !== undefined);
  const adapter = override ?? supported?.adapter;

  if (adapter === undefined) {
    const unsupported = detected[0];
    return {
      ...base,
      outcome: unsupported ? 'unsupported-runner' : 'undetected',
      detected,
      reportUrl: unsupported
        ? existingIssuesUrl(unsupported.name)
        : adapterRequestUrl(diagnostics),
    };
  }

  const warnings: string[] = [];
  if (override !== undefined && supported === undefined && detected.length > 0) {
    warnings.push(
      `${detected.map((r) => r.name).join(', ')} transforms sources before executing ` +
        `them, and the '${override}' recorder cannot see through that: the map will ` +
        `under-select, which breaks the fail-open guarantee. Keep running this suite ` +
        `in full until an adapter exists for it.`,
    );
  }
  if (adapter === 'vitest' && !deps.includes('@vitest/coverage-v8')) {
    warnings.push(
      'install @vitest/coverage-v8 before recording — the Vitest adapter records ' +
        "through Vitest's own coverage provider.",
    );
  }
  // A repo often runs several suites — Vitest for units, Playwright for E2E.
  // Configuring the one covsel can observe says nothing about the others, so
  // name them rather than let their silence read as coverage.
  if (supported !== undefined) {
    for (const runner of detected) {
      if (runner.adapter !== undefined) continue;
      warnings.push(
        `${runner.name} has no adapter yet; keep running that suite in full.`,
      );
    }
  }

  writeFileSync(base.configPath, `${JSON.stringify({ adapter }, null, 2)}\n`);

  return {
    ...base,
    outcome: 'configured',
    adapter,
    configWritten: true,
    detected,
    warnings,
    gitignoreUpdated: ensureGitignored(cwd, config.store.dir),
    commands: nextCommands(adapter, supported ?? detected[0]),
  };
}
