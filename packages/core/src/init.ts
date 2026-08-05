import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { findConfigFile, loadConfig } from './config.js';
import { LOCKFILES } from './lockfiles.js';

/**
 * Project bootstrap: work out which adapter records this project, say so, and —
 * once the answer is confirmed — persist it and keep the map out of version
 * control.
 *
 * covsel ships no adapters, each being a package the project installs, so the
 * first question in adopting it is which package that is. The answer is already
 * in `package.json`, in the runner the project declares, and reading it off is
 * both faster and more reliable than a human matching a runner to a table.
 *
 * Planning is separate from applying because the plan is the thing worth
 * showing someone before anything happens: detection can be wrong, and a wrong
 * adapter is a config that looks settled and records nothing useful. `planInit`
 * touches nothing; `applyInit` writes what the plan describes.
 *
 * Which adapter names are acceptable is not decided here. An adapter is an
 * ordinary package that anyone can publish, so the only authority on whether a
 * name has something behind it is the registry the caller installs from — this
 * plans the install and reports what it can see locally, and a name with nothing
 * behind it is the install's answer to give.
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
  /**
   * Packages recording needs besides the adapter itself. The Vitest adapter
   * reads Vitest's own coverage, which the project has to provide.
   */
  support?: readonly string[];
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
    support: ['@vitest/coverage-v8'],
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
    adapter: 'mocha',
    deps: ['mocha'],
    scripts: [/\bmocha\b/],
    command: 'mocha',
  },
  {
    name: 'playwright',
    adapter: 'playwright',
    deps: ['@playwright/test'],
    scripts: [/\bplaywright\b/],
    command: 'playwright test',
  },
  // Named without an adapter, which is the whole point of naming it: a Cypress
  // project gets told covsel cannot record it yet, instead of being handed the
  // generic wrap that would observe the spec process and record that no test
  // covers the app.
  { name: 'cypress', deps: ['cypress'], scripts: [/\bcypress\b/] },
];

/**
 * The adapter names covsel itself knows, read off the runner table so a new
 * adapter joins the moment its runner does. This is not the set of names init
 * accepts — anyone can publish an adapter, and covsel has no list of those — it
 * is only what a typo can be measured against.
 */
export function knownAdapters(): string[] {
  return [
    ...new Set([
      ...RUNNERS.flatMap((r) => (r.adapter === undefined ? [] : [r.adapter])),
      // The wrap-any-command adapter belongs to no single runner, so the table
      // never names it -- and it is the name most worth measuring a typo
      // against, being the one covsel falls back to with no `--adapter` at all.
      'generic',
    ]),
  ];
}

/** Edit distance, capped at `limit` so a far-off name costs almost nothing. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (row[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    if (Math.min(...row) > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length] ?? limit + 1;
}

/**
 * The adapter a name was probably meant to be, if any. A typo of a real adapter
 * is the likeliest reason an install of one comes back empty-handed, and the set
 * of names to compare against is small, so guessing costs little — as help after
 * the fact, never as a substitution and never as a reason to refuse a name.
 */
export function suggestAdapter(name: string): string | undefined {
  const limit = 2;
  let best: { name: string; distance: number } | undefined;
  for (const known of knownAdapters()) {
    const distance = editDistance(name.toLowerCase(), known, limit);
    // A suggestion has to be closer to the name than it is different from it,
    // or every three-letter typo suggests every three-letter adapter.
    if (distance > limit || distance >= known.length) continue;
    if (best === undefined || distance < best.distance) best = { name: known, distance };
  }
  return best?.name;
}

/** Dependency names worth naming in a bug report. */
const TEST_RELATED =
  /test|spec|jest|mocha|vitest|cucumber|playwright|ava|tap|karma|jasmine|cypress/i;

/** How each package manager installs dev dependencies. */
const INSTALL_ARGS: Record<string, readonly string[]> = {
  npm: ['install', '--save-dev'],
  pnpm: ['add', '--save-dev'],
  yarn: ['add', '--dev'],
  bun: ['add', '--dev'],
};

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
  /** A runner covsel records, not configured yet. */
  | 'configure'
  /** A config already exists; its adapter is the project's decision of record. */
  | 'already-configured'
  /** A runner covsel knows, but no adapter records it yet. */
  | 'unsupported-runner'
  /** No runner covsel recognises. */
  | 'undetected';

/** What `covsel init` would do, before it does any of it. */
export interface InitPlan {
  outcome: InitOutcome;
  /** The adapter name to record with, when there is one. */
  adapter?: string;
  /** Whether that adapter's package is installed, when the caller could check. */
  adapterInstalled?: boolean;
  /**
   * Packages the runner needs besides the adapter, which the project does not
   * have yet — installing the adapter alone would leave recording broken.
   */
  missingSupport: string[];
  /** The package manager to install with, by command name. */
  packageManager: string;
  /** Where the config lives, or would. */
  configPath: string;
  /** True when the config still has to be written. */
  needsConfig: boolean;
  gitignorePath: string;
  /** True when the map directory is not ignored yet. */
  needsGitignore: boolean;
  detected: DetectedRunner[];
  warnings: string[];
  diagnostics: InitDiagnostics;
  /** The commands to run once the project is set up. */
  commands?: { record: string; affected: string; run: string };
  /** Where to report a runner covsel could not configure. */
  reportUrl?: string;
}

/** What applying a plan changed. */
export interface InitResult {
  configWritten: boolean;
  gitignoreUpdated: boolean;
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
   *
   * It decides only whether the plan has to install the adapter, never whether
   * the name is acceptable — a name nothing provides is the install's answer.
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

/**
 * The package manager this project uses, by command name. A `packageManager`
 * field carries a version this has no use for, so it is trimmed to the name the
 * install command needs.
 */
export function detectPackageManager(cwd: string, declared?: string): string {
  const name = declared?.split('@')[0]?.trim();
  if (name !== undefined && name in INSTALL_ARGS) return name;
  for (const [lockfile, manager] of LOCKFILES) {
    if (existsSync(join(cwd, lockfile))) return manager;
  }
  return 'npm';
}

/** The argv that installs `packages` as dev dependencies with this manager. */
export function installCommand(packageManager: string, packages: string[]): string[] {
  const args = INSTALL_ARGS[packageManager] ?? INSTALL_ARGS['npm'] ?? [];
  return [packageManager, ...args, ...packages];
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

/** The `.gitignore` line that keeps a store directory out of version control. */
function gitignoreEntry(storeDir: string): string {
  return `${storeDir.replace(/\/+$/, '')}/`;
}

function isGitignored(cwd: string, storeDir: string): boolean {
  const path = join(cwd, '.gitignore');
  if (!existsSync(path)) return false;
  const entry = gitignoreEntry(storeDir);
  const bare = entry.slice(0, -1);
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim().replace(/^\//, ''))
    .some((line) => line === entry || line === bare);
}

function addGitignore(cwd: string, storeDir: string): void {
  const path = join(cwd, '.gitignore');
  const entry = gitignoreEntry(storeDir);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(path, `${existing}${separator}${entry}\n`);
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
 * Work out how this project would be set up, without touching it. Everything a
 * caller needs to describe the plan and ask whether it looks right is here;
 * nothing is written until `applyInit`.
 */
export async function planInit(options: InitOptions): Promise<InitPlan> {
  const { cwd, covselVersion } = options;
  const pkg = readPackageJson(cwd);
  const testScript = pkg?.scripts?.test;
  const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
  const packageManager = detectPackageManager(cwd, pkg?.packageManager);

  const diagnostics: InitDiagnostics = {
    covselVersion,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    packageManager: pkg?.packageManager ?? packageManager,
    ...(testScript !== undefined ? { testScript } : {}),
    dependencies: deps.filter((d) => TEST_RELATED.test(d)),
  };

  const detected = detectRunners(cwd);
  const supported = detected.find((r) => r.adapter !== undefined);
  const config = await loadConfig(cwd);
  const existing = findConfigFile(cwd);

  const base = {
    missingSupport: [] as string[],
    packageManager,
    configPath: existing ?? join(cwd, 'covsel.json'),
    needsConfig: false,
    gitignorePath: join(cwd, '.gitignore'),
    needsGitignore: !isGitignored(cwd, config.store.dir),
    detected,
    warnings: [] as string[],
    diagnostics,
  };

  const withInstalled = async (name: string): Promise<{ adapterInstalled?: boolean }> =>
    options.isAdapterInstalled === undefined
      ? {}
      : { adapterInstalled: await options.isAdapterInstalled(name) };

  // Packages the adapter needs beyond itself. Installing the adapter alone and
  // stopping would leave recording broken in a way that only shows up at record
  // time, so they are part of the same plan.
  //
  // Keyed on the adapter rather than the detected runner: someone who overrides
  // a Vitest project onto the generic wrap is not going to record through
  // Vitest's coverage provider, so installing it would be noise.
  const supportFor = (adapterName: string | undefined): string[] => {
    if (adapterName === undefined) return [];
    const signature = RUNNERS.find((r) => r.adapter === adapterName);
    return (signature?.support ?? []).filter((p) => !deps.includes(p));
  };

  // An existing config is the project's decision of record; init reports what it
  // says rather than what detection would have chosen, and only fills the gaps.
  if (existing !== undefined) {
    const named = config.adapter;
    return {
      ...base,
      outcome: 'already-configured',
      ...(named !== undefined ? { adapter: named, ...(await withInstalled(named)) } : {}),
      missingSupport: supportFor(named),
      warnings:
        named === undefined && supported !== undefined
          ? [
              `${existing} names no adapter, so commands fall back to the default; ` +
                `add "adapter": "${supported.adapter}" to record ${supported.name} with.`,
            ]
          : [],
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

  return {
    ...base,
    outcome: 'configure',
    adapter,
    ...(await withInstalled(adapter)),
    missingSupport: supportFor(adapter),
    needsConfig: true,
    warnings,
    commands: nextCommands(adapter, supported ?? detected[0]),
  };
}

/**
 * Carry out a plan: write the config it names and ignore the map directory.
 * Installing packages is the caller's job — it owns the terminal the package
 * manager needs — so this covers only what covsel itself writes.
 */
export async function applyInit(cwd: string, plan: InitPlan): Promise<InitResult> {
  const result: InitResult = { configWritten: false, gitignoreUpdated: false };
  // A plan that could not name an adapter is a report, not an instruction. It
  // still carries the paths it would have touched, so applying it has to be
  // inert rather than trusting the caller to check the outcome first.
  if (plan.outcome !== 'configure' && plan.outcome !== 'already-configured') {
    return result;
  }
  const config = await loadConfig(cwd);

  if (plan.needsConfig && plan.adapter !== undefined) {
    writeFileSync(
      plan.configPath,
      `${JSON.stringify({ adapter: plan.adapter }, null, 2)}\n`,
    );
    result.configWritten = true;
  }
  if (plan.needsGitignore) {
    addGitignore(cwd, config.store.dir);
    result.gitignoreUpdated = true;
  }
  return result;
}
