import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  type Adapter,
  type AffectedResult,
  archiveDirFor,
  compareSuites,
  computeStatus,
  type CoverageMap,
  type CovselConfig,
  DEFAULT_ARCHIVE_KEEP,
  discoverTestFiles,
  type ExplainResult,
  explainPath,
  fetchMap,
  hasDrift,
  type InitDiagnostics,
  type Recorder,
  type RecorderInit,
  type InitPlan,
  installCommand,
  planInit,
  suggestAdapter,
  applyInit,
  loadConfig,
  isDirtyWorkTree,
  isUsableMap,
  loadRawConfig,
  LocalStore,
  MAP_SCHEMA_VERSION,
  mergeMaps,
  publishMap,
  recordMap,
  resolveConfigFor,
  runAffected,
  runAffectedSelection,
  selectAffected,
  type StatusResult,
  type TestId,
  watchAffected,
  type WatchEvent,
} from '@covsel/core';

import {
  AdapterResolutionError,
  adapterSpecifiers,
  DEFAULT_ADAPTER,
  loadAdapter,
} from './adapters.js';

/** How many tests or sources `explain` lists before summarizing the rest. */
const EXPLAIN_LIMIT = 20;

const HELP = `covsel -- runtime-coverage test impact analysis for any JS/TS runner

Usage:
  covsel init [--adapter <name>] [--auto-approve] [--no-install]
                                                   Set covsel up for this project
  covsel record [--adapter <name>] -- <command>   Run the suite and build the map
  covsel affected [--since <ref>] [--format <fmt>] Print tests the diff can affect
  covsel run -- <command>                          Run only the affected tests
  covsel watch -- <command>                        Rerun affected tests as you edit
  covsel status [--format <fmt>]                   Show map age, size, and next action
  covsel doctor [--require] [--format <fmt>]       Check covsel's test discovery against
                -- <command>                       what the runner itself collects
  covsel explain <path> [--all]                    Show what covers a file, or what
                                                   a test covers
  covsel merge <maps...> [--out <file>]            Merge CI shard maps into one
  covsel publish [--archive <dir>] [--keep <n>]    Archive the map under its commit
  covsel fetch [--archive <dir>] [--require]       Install the best archived map
               [--format <fmt>]
  covsel --help                                    Show this help
  covsel --version                                 Show version

Options:
  --adapter <name>   Installed adapter package for record/affected/run/watch
                     (default: the config's adapter, else '${DEFAULT_ADAPTER}';
                     adapters install separately)
  --since <ref>      Diff against <ref> instead of the commit the map records
  --format <fmt>     affected/status/fetch/doctor: 'json' for one object on stdout,
                     for a script to read (default: 'files' for affected, 'text'
                     for the rest)
  --auto-approve     init: carry the plan out without asking (required with no
                     terminal, since init changes the project)
  --no-install       init: plan to configure without installing, and print the
                     install command you will need
  --debounce <ms>    watch: quiet period after a change before running (default 200)
  --record           watch: re-record the map after a run that passes
  --no-initial-run   watch: wait for the first change instead of running at startup
  --archive <dir>    publish/fetch: the archive directory (default <store>/archive)
  --keep <n>         publish: maps to keep, oldest pruned first (default ${DEFAULT_ARCHIVE_KEEP})
  --require          fetch: exit non-zero when no archived map can be used;
                     doctor: exit non-zero when the adapter cannot run the check
  --force            fetch: replace a local map recorded more recently
  --all              explain: list every test and source instead of the first ${EXPLAIN_LIMIT}

init detects the runner, shows what it would change, and on your say-so installs
its adapter and writes that adapter to the config, so later commands need no
--adapter. record wraps a runner and observes each test file in its own process
to learn which sources it executes. affected prints those test files a diff can
affect, so \`<runner> $(covsel affected)\` runs only what is needed. watch drives
the same selection continuously, running the affected tests on every save.
explain reads the map in the other direction -- what covers this file, what this
test covered, and what a change to it would select. doctor compares covsel's
testGlobs against the files the runner itself collects: a file the runner runs
and covsel never discovers is one no change can select, which is a test that
leaves the suite without anything saying so.

covsel never skips a test whose behavior your change could alter -- and when it
can't be sure, it runs it (fail-open). Map schema v${MAP_SCHEMA_VERSION}.
`;

export const VERSION = '0.0.0';

const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);

function splitAtDoubleDash(args: string[]): { opts: string[]; command: string[] } {
  const idx = args.indexOf('--');
  if (idx === -1) return { opts: args, command: [] };
  return { opts: args.slice(0, idx), command: args.slice(idx + 1) };
}

/** Read `--key value` / `--key=value` from a flat option list. */
function flag(opts: string[], name: string): string | undefined {
  for (let i = 0; i < opts.length; i++) {
    const cur = opts[i];
    if (cur === `--${name}`) return opts[i + 1];
    if (cur?.startsWith(`--${name}=`)) return cur.slice(name.length + 3);
  }
  return undefined;
}

/** True when a bare `--name` switch is present. */
function hasFlag(opts: string[], name: string): boolean {
  return opts.includes(`--${name}`);
}

/**
 * Read `--format` for a command that can answer as prose or as data. `human` is
 * what this command calls its own output — `affected` prints a list of files,
 * the rest print a report — so the error names the two formats that command
 * actually has rather than a vocabulary shared with commands it is not.
 *
 * `undefined` means the value was rejected and said so; the caller exits 1.
 */
function readFormat(
  cmd: string,
  opts: string[],
  human: string,
): 'human' | 'json' | undefined {
  const value = flag(opts, 'format');
  // `--format` with nothing after it is a caller who meant to name a format, not
  // one asking for the default -- `covsel affected --format "$FMT"` with `FMT`
  // unset produces exactly this. Defaulting there prints prose to a pipeline
  // that asked for data, and the parser downstream reads it as an empty answer.
  if (value === undefined && hasFlag(opts, 'format')) {
    err(`covsel ${cmd}: --format needs a value ('${human}' or 'json')\n`);
    return undefined;
  }
  const format = value ?? human;
  if (format === human) return 'human';
  if (format === 'json') return 'json';
  err(
    `covsel ${cmd}: unsupported --format '${format}' (expected '${human}' or 'json')\n`,
  );
  return undefined;
}

/**
 * Write the machine-readable answer: one object, one line, on stdout.
 *
 * One line so a caller can read it without a JSON parser at all, and stdout
 * alone so `covsel status --format json | jq` never has to strip anything first.
 * Everything a human would want alongside it — what was skipped, why a run is
 * full — keeps its place on stderr, where it does not have to be valid anything.
 */
function json(value: unknown): void {
  out(`${JSON.stringify(value)}\n`);
}

/**
 * Resolve `--adapter` to the object every command reads its capabilities off:
 * one covsel ships, or one the project installed. A name that resolves to
 * nothing, or to something that is not an adapter, is reported with what went
 * wrong rather than quietly falling back to the default.
 */
async function resolveAdapter(
  cmd: string,
  opts: string[],
  cwd: string,
): Promise<Adapter | undefined> {
  // Precedence: the flag, then the name `covsel init` wrote to the config, then
  // the default. The config is read for the name alone, before an adapter exists
  // to resolve the rest of it with.
  const name =
    flag(opts, 'adapter') ?? (await loadRawConfig(cwd)).adapter ?? DEFAULT_ADAPTER;
  try {
    return await loadAdapter(name, cwd);
  } catch (e) {
    err(`covsel ${cmd}: ${e instanceof Error ? e.message : String(e)}\n`);
    return undefined;
  }
}

/**
 * Build the adapter's recorder, reporting a refusal rather than crashing on it.
 * An adapter is entitled to check up front that it can actually record — the
 * Vitest one needs its coverage provider installed — and that reads as a message
 * to act on, not a stack trace.
 */
function makeRecorder(
  cmd: string,
  adapter: Adapter,
  init: RecorderInit,
): Recorder | undefined {
  try {
    return adapter.createRecorder(init);
  } catch (e) {
    err(`covsel ${cmd}: ${e instanceof Error ? e.message : String(e)}\n`);
    return undefined;
  }
}

/**
 * Load config, letting the chosen adapter supply the test globs when the project
 * has not set them, so a runner whose tests are not `*.test.*` sources still
 * works with no configuration.
 */
async function loadConfigFor(cwd: string, adapter: Adapter): Promise<CovselConfig> {
  return resolveConfigFor(adapter, await loadRawConfig(cwd));
}

function reportSelection(result: AffectedResult): void {
  if (result.fullRun) {
    err(
      `covsel: full run -- ${result.reason ?? 'map cannot be trusted for this diff'}\n`,
    );
  } else if (result.tests.length === 0) {
    err('covsel: no affected tests\n');
  }
}

function printDiagnostics(d: InitDiagnostics): void {
  err('\nInclude these details in the report:\n');
  err(`  covsel:          ${d.covselVersion}\n`);
  err(`  node:            ${d.nodeVersion}\n`);
  err(`  platform:        ${d.platform}\n`);
  err(`  package manager: ${d.packageManager}\n`);
  if (d.testScript !== undefined) err(`  test script:     ${d.testScript}\n`);
  if (d.dependencies.length > 0) {
    err(`  dependencies:    ${d.dependencies.join(', ')}\n`);
  }
  err('\nReview them before sharing — the tracker is public.\n');
}

function printNextSteps(commands: {
  record: string;
  affected: string;
  run: string;
  setup?: string[];
}): void {
  // Before the commands, because for a runner that needs them the commands
  // refuse until they are done -- and someone reading a "Next:" list has every
  // reason to expect the first line to work.
  if (commands.setup !== undefined && commands.setup.length > 0) {
    out('\nFirst, in your project:\n');
    for (const step of commands.setup) out(`  - ${step}\n`);
  }
  out('\nNext:\n');
  out(`  ${commands.record}\n`);
  out(`  ${commands.affected}\n`);
  out(`  ${commands.run}\n`);
}

/**
 * Whether the package behind an adapter name is installed. Resolution failures
 * other than absence — an adapter that throws on import, or exports the wrong
 * shape — are the runner's problem to report at record time, not a reason for
 * init to withhold the name.
 */
async function adapterIsInstalled(name: string, cwd: string): Promise<boolean> {
  try {
    await loadAdapter(name, cwd);
    return true;
  } catch (e) {
    return !(e instanceof AdapterResolutionError);
  }
}

/** Ask the terminal. Only reached when there is one. */
async function confirm(question: string): Promise<boolean> {
  // The prompt goes to stderr so `covsel init > plan.txt` from a terminal still
  // shows the question rather than looking like a hang.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`\n${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * What covsel is and what setting it up involves, for the reader who typed
 * `covsel init` on a recommendation and has not read the docs. Printed only
 * when there is something to do, so a repeat run stays quiet.
 */
function printIntro(): void {
  out('covsel — run only the tests your changes can affect\n\n');
  out(
    'It records which sources each test actually executes, then uses a git diff\n' +
      'to select the tests whose covered code changed. Watching a runner takes an\n' +
      'adapter built for it, and that is the one thing setup has to get right:\n' +
      'this reads your package.json to work out which one, then sets it up.\n\n',
  );
}

/**
 * Show the plan before carrying it out — this is what there is to confirm, so
 * everything the run would do, and everything it deliberately would not, has to
 * be visible here. `--no-install` in particular is a different plan rather than
 * a quieter one: agreeing to it means agreeing to finish the install yourself.
 */
function describePlan(plan: InitPlan, needed: string[], install: boolean): void {
  for (const runner of plan.detected) {
    const how =
      runner.adapter === undefined ? 'no adapter yet' : `adapter ${runner.adapter}`;
    out(`covsel init: detected ${runner.name} — ${runner.evidence} (${how})\n`);
  }
  if (plan.detected.length === 0 && plan.adapter !== undefined) {
    out(`covsel init: using the adapter you named — ${plan.adapter}\n`);
  }
  out('\nPlan:\n');
  // One list, and whether it is being installed — so the packages can never be
  // described by one variable and acted on by another.
  if (needed.length > 0) {
    out(
      install
        ? `  install  ${needed.join(', ')} (${plan.packageManager})\n`
        : `  skip     installing ${needed.join(', ')} (--no-install)\n`,
    );
  }
  if (plan.needsConfig) out(`  write    ${plan.configPath} (adapter: ${plan.adapter})\n`);
  if (plan.needsGitignore) out(`  ignore   the map directory in ${plan.gitignorePath}\n`);
  if (!install && needed.length > 0) {
    out(
      `\nRecording needs those packages, so you will have to run:\n` +
        `  ${installCommand(plan.packageManager, needed).join(' ')}\n`,
    );
  }
}

/**
 * What one invocation of the package manager did. `aborted` separates a run
 * that was killed — Ctrl-C, or anything else that signals it — from one that
 * exited with a failing status, because the two mean opposite things about
 * whether to try something else.
 */
interface InstallOutcome {
  status: number;
  aborted: boolean;
}

/** Hand the install to the project's own package manager, output and all. */
function installPackages(
  cwd: string,
  manager: string,
  packages: string[],
): InstallOutcome {
  const [command, ...args] = installCommand(manager, packages);
  if (command === undefined) return { status: 1, aborted: false };
  out(`\ncovsel init: ${[command, ...args].join(' ')}\n`);
  const { status, signal, error } = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (error !== undefined) {
    err(`covsel init: ${manager} could not be run: ${error.message}\n`);
    return { status: 1, aborted: false };
  }
  // A null status means the package manager was killed rather than finishing.
  if (status === null) {
    err(
      `covsel init: ${manager} was interrupted${signal === null ? '' : ` (${signal})`}\n`,
    );
    return { status: 1, aborted: true };
  }
  return { status, aborted: false };
}

/**
 * Install what the project is missing, trying each specifier the adapter name
 * can mean until one takes. The specifiers are alternatives rather than a list
 * to install: a short name expands to the official scope first and the community
 * prefix second, only the registry knows which one was published, and a failure
 * on the first therefore says nothing about the name.
 *
 * Reports the status that decided it and every command it asked the package
 * manager to run — a name installed under its second specifier is an ordinary
 * success, and one installed under neither has to be able to say what was tried.
 */
function installMissing(
  cwd: string,
  plan: InitPlan,
  candidates: string[],
): { status: number; attempted: string[]; failed: 'adapter' | 'support' | undefined } {
  const attempted: string[] = [];
  const attempt = (packages: string[]): InstallOutcome => {
    attempted.push(installCommand(plan.packageManager, packages).join(' '));
    return installPackages(cwd, plan.packageManager, packages);
  };

  // The adapter goes in on its own, separately from the support packages. Sent
  // together, a support package that will not install is indistinguishable from
  // a specifier that does not exist — so covsel would move on to the next
  // specifier and install a differently-named package for a reason that had
  // nothing to do with the name.
  if (candidates.length > 0) {
    let outcome: InstallOutcome = { status: 1, aborted: false };
    for (const specifier of candidates) {
      outcome = attempt([specifier]);
      // Only a package manager that ran and refused says anything about this
      // specifier. One that was killed says nothing, and trying the next name
      // would turn an interrupted install into an install of something else.
      if (outcome.status === 0 || outcome.aborted) break;
    }
    if (outcome.status !== 0)
      return { status: outcome.status, attempted, failed: 'adapter' };
  }

  if (plan.missingSupport.length === 0)
    return { status: 0, attempted, failed: undefined };
  const outcome = attempt(plan.missingSupport);
  return {
    status: outcome.status,
    attempted,
    failed: outcome.status === 0 ? undefined : 'support',
  };
}

/**
 * Say what a failed install leaves behind, which — since the install runs first
 * — is nothing covsel wrote. The package manager has already printed why it
 * failed; this adds what covsel asked it for, and what that does and does not
 * prove about the name.
 */
function reportInstallFailure(
  plan: InitPlan,
  candidates: string[],
  attempted: string[],
  failed: 'adapter' | 'support' | undefined,
  ignored: boolean,
): void {
  const named =
    failed === 'adapter' && candidates.length > 1 && plan.adapter !== undefined
      ? ` covsel asked for each package '${plan.adapter}' can name:`
      : '';
  err(`\ncovsel init: the install failed.${named}\n`);
  for (const command of attempted) err(`  ${command}\n`);

  // A typo of a real adapter is the likeliest reason an install of one comes
  // back empty-handed. Offered only after the fact: an adapter covsel has never
  // heard of is as acceptable a name as one it ships an adapter for.
  const suggestion =
    plan.adapter === undefined || failed !== 'adapter'
      ? undefined
      : suggestAdapter(plan.adapter);
  if (suggestion !== undefined && suggestion !== plan.adapter) {
    err(`\nDid you mean:\n  covsel init --adapter ${suggestion}\n`);
  }

  // An install that fails proves only that this install failed -- a private
  // registry, an offline machine and a name with nothing behind it all look the
  // same from here -- so this says what happened and stops. A project that was
  // already configured keeps what it had, and saying nothing was written would
  // read as covsel having taken that away.
  const blame =
    failed === 'adapter'
      ? 'an adapter that could not be installed'
      : 'a runner whose recording needs a package that could not be installed';
  err(
    plan.needsConfig
      ? `\nNo config was written, so the project is not left configured for ${blame}.\n`
      : `\n${plan.configPath} is unchanged — it already names ` +
          `${plan.adapter ?? 'no adapter'}. Recording still needs that install.\n`,
  );
  // The map directory is ignored either way. Whether covsel can record has no
  // bearing on whether its output belongs in version control, and the user
  // agreed to that line of the plan.
  if (ignored) err(`The map directory is ignored in ${plan.gitignorePath} regardless.\n`);
}

async function cmdInit(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const adapter = flag(argv, 'adapter');
  const autoApprove = hasFlag(argv, 'auto-approve');
  const noInstall = hasFlag(argv, 'no-install');

  const plan = await planInit({
    cwd,
    covselVersion: VERSION,
    isAdapterInstalled: (name) => adapterIsInstalled(name, cwd),
    ...(adapter !== undefined ? { adapter } : {}),
  });

  // The package specifiers the adapter name can mean, in order, or none when the
  // project already has it. Alternatives, not a list to install: whichever one
  // the adapter was published under is the one that takes.
  const candidates =
    plan.adapter !== undefined && plan.adapterInstalled === false
      ? adapterSpecifiers(plan.adapter)
      : [];

  // covsel ships no adapters, so the package is as much a part of being set up
  // as the config is: a config naming an adapter nobody installed reads as done
  // and fails at the first record. The adapter is shown as the alternatives it
  // really is, since which one exists is not knowable until the install runs and
  // a plan naming one while the run installs another is a plan that lied.
  const adapterEntry =
    candidates.length > 1
      ? `${candidates[0]} (or ${candidates.slice(1).join(', ')})`
      : candidates[0];
  const needed = [
    ...(adapterEntry === undefined ? [] : [adapterEntry]),
    ...plan.missingSupport,
  ];
  const installing = !noInstall && needed.length > 0;
  // Measured against what the project is missing, not against what this run
  // would install: `--no-install` must not turn "your adapter is absent" into
  // "already set up", which is the exact reading that fails at the first record.
  const alreadySetUp = !plan.needsConfig && !plan.needsGitignore && needed.length === 0;

  // Everything below either changes the project or explains why it cannot, so
  // the reader deserves to know what covsel is first. The already-set-up run is
  // the one that changes nothing, and repeat runs should stay quiet.
  if (!alreadySetUp) printIntro();

  if (plan.outcome === 'unsupported-runner') {
    const names = plan.detected.map((r) => r.name).join(', ');
    err(
      `covsel init: no adapter records ${names} yet, so covsel cannot select its ` +
        `tests. Keep running that suite in full.\n`,
    );
    err(`\nTracking: ${plan.reportUrl}\n`);
    err(
      `\nIf an adapter for it exists under another name, name it yourself:\n` +
        `  covsel init --adapter <name>\n`,
    );
    return 1;
  }

  if (plan.outcome === 'undetected') {
    err('covsel init: no test runner detected in this project.\n');
    err(
      `\nIf covsel should support your runner, please open an adapter request:\n  ${plan.reportUrl}\n`,
    );
    printDiagnostics(plan.diagnostics);
    err(
      `\nTo configure covsel now, name the adapter yourself:\n  covsel init --adapter <name>\n`,
    );
    return 1;
  }

  for (const warning of plan.warnings) err(`covsel init: warning — ${warning}\n`);

  if (alreadySetUp) {
    out(
      `covsel init: already set up — ${plan.configPath} (adapter: ${plan.adapter ?? 'unset'})\n`,
    );
    if (plan.commands) printNextSteps(plan.commands);
    return 0;
  }

  describePlan(plan, needed, !noInstall);

  // `--no-install` can leave a plan that changes nothing: the packages were the
  // only thing outstanding and we were told not to install them. Reporting them
  // is the whole job, and there is nothing to consent to.
  if (!plan.needsConfig && !plan.needsGitignore && !installing) return 0;

  // init writes files and installs packages, so it does nothing without an
  // answer. With no terminal to ask, silence is not one: a run in CI or under an
  // agent has to say so with --auto-approve, which is why the flag is not named
  // for answering a prompt.
  if (!autoApprove) {
    if (!process.stdin.isTTY) {
      err('\ncovsel init: nothing changed — no terminal to confirm with.\n');
      err('Run covsel init --auto-approve to carry this plan out unattended.\n');
      return 1;
    }
    if (!(await confirm('Set covsel up this way?'))) {
      out('covsel init: nothing changed.\n');
      if (plan.detected.length > 0) {
        out('Name the right adapter yourself with: covsel init --adapter <name>\n');
      }
      return 0;
    }
  }

  // Install first, write second. An adapter is an ordinary package and covsel
  // keeps no list of the ones that exist, so the install is what finds out
  // whether this name is one -- and running it first is what keeps a name
  // nothing provides from leaving behind a config every later command fails on.
  //
  // --no-install is the exception, and deliberately so rather than by oversight.
  // It says the project brings its own packages, which leaves no install to find
  // out whether the adapter name has anything behind it, so the config is
  // written on the caller's word. That is the way in for an adapter arriving
  // from a private registry, a lockfile, or a workspace link.
  if (installing) {
    const { status, attempted, failed } = installMissing(cwd, plan, candidates);
    if (status !== 0) {
      // The config is withheld — that is the whole point of installing first —
      // but ignoring the map directory never depended on the install, and the
      // user agreed to it. Doing it anyway keeps `.covsel/` uncommittable even
      // when setup could not finish.
      const ignored =
        plan.needsGitignore &&
        (await applyInit(cwd, { ...plan, needsConfig: false })).gitignoreUpdated;
      reportInstallFailure(plan, candidates, attempted, failed, ignored);
      return status;
    }
  }

  const applied = await applyInit(cwd, plan);
  if (applied.configWritten) {
    out(`covsel init: wrote ${plan.configPath} (adapter: ${plan.adapter})\n`);
  }
  if (applied.gitignoreUpdated) {
    out(`covsel init: added the map directory to ${plan.gitignorePath}\n`);
  }

  // Said once in the plan and again here: between the two, the install ran for
  // everything else, so this is the one thing still standing between the project
  // and a working `record`.
  if (noInstall && needed.length > 0) {
    // Every specifier, not just the first: the adapter may be published under
    // the community prefix, and handing over a command that 404s is worse than
    // handing over two.
    const commands =
      candidates.length > 0
        ? candidates.map((c) =>
            installCommand(plan.packageManager, [c, ...plan.missingSupport]).join(' '),
          )
        : [installCommand(plan.packageManager, plan.missingSupport).join(' ')];
    out(
      `\ncovsel init: not installed (--no-install). Recording needs${
        commands.length > 1 ? ' whichever of these the adapter was published under' : ''
      }:\n${commands.map((c) => `  ${c}\n`).join('')}`,
    );
  }

  if (plan.commands) printNextSteps(plan.commands);
  return 0;
}

async function cmdRecord(argv: string[]): Promise<number> {
  const { opts, command } = splitAtDoubleDash(argv);
  if (command.length === 0) {
    err(
      'covsel record: expected a runner command after `--`, e.g. covsel record -- vitest run\n',
    );
    return 1;
  }
  const cwd = process.cwd();
  const adapter = await resolveAdapter('record', opts, cwd);
  if (!adapter) return 1;
  const config = await loadConfigFor(cwd, adapter);
  const recorder = makeRecorder('record', adapter, { command, cwd, config });
  if (!recorder) return 1;

  const result = await recordMap({
    cwd,
    config,
    recorder,
    onEvent: (e) => {
      if (e.kind === 'recorded') {
        err(`  recorded ${e.file} (${e.tests} tests, ${e.sources} sources)\n`);
        // A count of zero sources printed as ordinary progress is how this went
        // unnoticed: it reads like any other line. Named here, at the moment it
        // is recorded, because the cause is almost always visible from the test
        // itself -- it drives its subject somewhere the recorder cannot watch.
        if (e.unmeasured !== undefined) {
          err(
            `  NO SOURCES ${e.file}: ${e.unmeasured} of ${e.tests} unit(s) recorded no ` +
              `covered source in this repository, so nothing a diff carries can ` +
              `match them and this file is selected on every run\n`,
          );
        }
        // Every allowed script is coverage this entry does not have. Saying so
        // on each recording is what keeps the accommodation from becoming the
        // silent hole it exists to replace.
        if (e.allowedUnmappable) {
          err(
            `  UNMAPPED ${e.file}: accepted ${e.allowedUnmappable.join(', ')} ` +
              `(sourceMaps.allowUnmappable); nothing they executed is recorded\n`,
          );
        }
      } else err(`  FAILED   ${e.file}: ${e.reason}\n`);
    },
  });

  if (!result.ok) {
    // A run-level failure is not a count of broken test files, and reporting it
    // as "0 test file(s) failed" would read like nothing went wrong.
    if (result.error !== undefined) {
      err(`covsel record: ${result.error}\n`);
      err('covsel record: no map written -- an empty map would select no tests.\n');
      return 1;
    }
    err(
      `covsel record: ${result.failures.length} test file(s) failed; map not written ` +
        `(a partial map cannot be trusted).\n`,
    );
    // Refusing to write is only half the story when a map is already there: the
    // old one keeps driving selection, and it is the one recorded before
    // whatever just failed.
    if (existsSync(result.mapPath)) {
      err(
        `covsel record: the previous map at ${result.mapPath} is unchanged and ` +
          `still what covsel affected uses.\n`,
      );
    }
    return 1;
  }
  err(`covsel record: wrote ${result.recorded} entries to ${result.mapPath}\n`);
  if (result.unmeasured !== undefined) {
    // Said again at the end, because the per-file line above scrolls past in a
    // suite of any size. Selection is already safe here -- these run whatever
    // the diff -- so this is about the CI minutes they cost until whatever the
    // recorder could not watch is brought into view.
    err(
      `covsel record: ${result.unmeasured.length} recorded unit(s) cover no source, ` +
        `so their test files are selected on every run: ${[
          ...new Set(result.unmeasured.map((t) => t.file)),
        ].join(', ')}\n`,
    );
  }
  if (result.unanchored) {
    // Said here rather than left for selection to explain later: the map is
    // correct about what it saw, and deliberately claims no commit, so every
    // selection until the next recording is a full run.
    err(
      'covsel record: recorded from a tree with uncommitted changes, so the map ' +
        'is not anchored to a commit -- selection will fall open to a full run ' +
        'until you commit and re-record.\n',
    );
  }
  return 0;
}

async function cmdAffected(argv: string[]): Promise<number> {
  const format = readFormat('affected', argv, 'files');
  if (format === undefined) return 1;
  const cwd = process.cwd();
  const adapter = await resolveAdapter('affected', argv, cwd);
  if (!adapter) return 1;
  const since = flag(argv, 'since');
  const config = await loadConfigFor(cwd, adapter);
  const result = await selectAffected({ cwd, config, ...(since ? { since } : {}) });
  reportSelection(result);
  // The same list the adapter would append to the runner's command line, so
  // `<runner> $(covsel affected)` and `covsel run` agree by construction.
  const files = adapter.formatSelection(result.selected);
  if (format === 'json') {
    // `files` is the adapter's runner-native rendering and `tests` the plain
    // test files behind it. They differ wherever selection is per-test, and a
    // caller sharding the suite needs the files while one running the command
    // needs the rendering — so both are reported rather than one guessed at.
    json({
      fullRun: result.fullRun,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      files,
      tests: result.tests,
      selected: result.selected,
      discovered: result.discovered,
    });
    return 0;
  }
  if (files.length > 0) out(`${files.join('\n')}\n`);
  return 0;
}

async function cmdRun(argv: string[]): Promise<number> {
  const { opts, command } = splitAtDoubleDash(argv);
  if (command.length === 0) {
    err(
      'covsel run: expected a runner command after `--`, e.g. covsel run -- vitest run\n',
    );
    return 1;
  }
  const cwd = process.cwd();
  const adapter = await resolveAdapter('run', opts, cwd);
  if (!adapter) return 1;
  const since = flag(opts, 'since');
  const config = await loadConfigFor(cwd, adapter);

  return runAffected(
    { adapter, cwd, config, command, ...(since ? { since } : {}) },
    reportSelection,
  );
}

/** Render one watch-loop event as a line of status on stderr. */
function reportWatchEvent(event: WatchEvent): void {
  switch (event.kind) {
    case 'watching':
      err(`covsel watch: watching for changes (debounce ${event.debounceMs}ms)\n`);
      break;
    case 'change': {
      const what = event.unnamed
        ? 'a change the watcher could not name'
        : event.paths.length === 1
          ? event.paths[0]
          : `${event.paths.length} files`;
      err(`\ncovsel watch: changed — ${what}\n`);
      break;
    }
    case 'selected':
      reportSelection(event.selection);
      if (!event.selection.fullRun && event.selection.tests.length > 0) {
        err(`covsel watch: running ${event.selection.selected.length} test(s)\n`);
      }
      break;
    case 'ran':
      err(`covsel watch: ${event.code === 0 ? 'pass' : `fail (exit ${event.code})`}\n`);
      break;
    case 'recorded':
      err(
        event.ok
          ? 'covsel watch: map re-recorded\n'
          : `covsel watch: map not re-recorded (${event.reason ?? 'record failed'}); ` +
              'the previous map still stands, so selection stays conservative\n',
      );
      break;
    case 'warning':
      err(`covsel watch: ${event.reason}\n`);
      break;
    case 'watcher-failed':
      err(
        `covsel watch: ${event.reason}\n` +
          'covsel watch: stopping — a watcher that cannot see changes would ' +
          'silently stop selecting tests\n',
      );
      break;
  }
}

async function cmdWatch(argv: string[]): Promise<number> {
  const { opts, command } = splitAtDoubleDash(argv);
  if (command.length === 0) {
    err(
      'covsel watch: expected a runner command after `--`, e.g. covsel watch -- vitest run\n',
    );
    return 1;
  }
  const cwd = process.cwd();
  const adapter = await resolveAdapter('watch', opts, cwd);
  if (!adapter) return 1;

  const debounceRaw = flag(opts, 'debounce');
  const debounceMs = debounceRaw === undefined ? undefined : Number(debounceRaw);
  if (debounceMs !== undefined && (!Number.isFinite(debounceMs) || debounceMs < 0)) {
    err(`covsel watch: --debounce needs a non-negative number of milliseconds\n`);
    return 1;
  }

  const since = flag(opts, 'since');
  const config = await loadConfigFor(cwd, adapter);

  // Re-recording is opt-in: it re-runs the whole suite, and a map that only ages
  // over-selects, so the default trades precision for the latency watch exists
  // to give.
  const record = hasFlag(opts, 'record')
    ? async (): Promise<{ ok: boolean; reason?: string }> => {
        // A map is stamped with HEAD, so recording from an edited tree would
        // describe code that commit does not contain — and a later checkout of
        // exactly HEAD would then trust it and could skip a test. Waiting for a
        // commit costs freshness; recording anyway costs the guarantee.
        if (isDirtyWorkTree(cwd)) {
          return {
            ok: false,
            reason:
              'the working tree has uncommitted changes, so a fresh map ' +
              'would describe a state no commit names',
          };
        }
        const recorder = makeRecorder('watch', adapter, { command, cwd, config });
        if (!recorder) return { ok: false, reason: 'the adapter cannot record' };
        const result = await recordMap({ cwd, config, recorder });
        return result.ok
          ? { ok: true }
          : {
              ok: false,
              // `error` when the recording failed as a whole — a run-mode
              // recorder whose single invocation threw has no per-file failures,
              // and reporting "0 test file(s) failed" reads like nothing did.
              reason:
                result.error ?? `${result.failures.length} test file(s) failed to record`,
            };
      }
    : undefined;

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    return await watchAffected({
      cwd,
      config,
      run: (selection) =>
        runAffectedSelection({ adapter, selection, command, cwd }).status,
      onEvent: reportWatchEvent,
      signal: controller.signal,
      ...(since !== undefined ? { since } : {}),
      ...(debounceMs !== undefined ? { debounceMs } : {}),
      ...(record !== undefined ? { record } : {}),
      ...(hasFlag(opts, 'no-initial-run') ? { initialRun: false } : {}),
    });
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

/**
 * The status report as data. Built field by field rather than handed core's
 * result straight out, so what covsel promises a script is decided here and
 * changes only when someone means to change it.
 *
 * Absent means unknown, never zero: a map covsel could not read has no entry
 * count, and a key reading 0 would describe an empty map instead of an
 * unreadable one.
 */
function statusJson(s: StatusResult): unknown {
  return {
    mapPath: s.mapPath,
    mapState: s.mapState,
    ...(s.unusableReason !== undefined ? { unusableReason: s.unusableReason } : {}),
    ...(s.discoveredTestCount !== undefined
      ? { discoveredTestCount: s.discoveredTestCount }
      : {}),
    ...(s.ignoredTestCount !== undefined ? { ignoredTestCount: s.ignoredTestCount } : {}),
    ...(s.recordedAt !== undefined ? { recordedAt: s.recordedAt } : {}),
    ...(s.commit !== undefined ? { commit: s.commit } : {}),
    ...(s.ageMs !== undefined ? { ageMs: s.ageMs } : {}),
    ...(s.granularity !== undefined ? { granularity: s.granularity } : {}),
    ...(s.observed !== undefined ? { observed: s.observed } : {}),
    ...(s.entryCount !== undefined ? { entryCount: s.entryCount } : {}),
    ...(s.staleEntryCount !== undefined ? { staleEntryCount: s.staleEntryCount } : {}),
    ...(s.unmeasuredEntryCount !== undefined
      ? { unmeasuredEntryCount: s.unmeasuredEntryCount }
      : {}),
    ...(s.coveredFileCount !== undefined ? { coveredFileCount: s.coveredFileCount } : {}),
    ...(s.coveredSourcesByDir !== undefined
      ? { coveredSourcesByDir: s.coveredSourcesByDir }
      : {}),
    ...(s.coveredBlockCount !== undefined
      ? { coveredBlockCount: s.coveredBlockCount }
      : {}),
    changedSentinels: s.changedSentinels,
    nextIsFullRun: s.nextIsFullRun,
    ...(s.nextFullRunReason !== undefined
      ? { nextFullRunReason: s.nextFullRunReason }
      : {}),
  };
}

/**
 * Compare what covsel discovers against what the runner collects.
 *
 * The two are separate configurations that must agree and nothing makes them.
 * When they drift, the failure is silent in the direction that matters: a file
 * the runner collects and covsel does not discover is recorded by nothing,
 * selected by nothing, and simply stops running the day selection decides what
 * runs -- on a green job, with no line anywhere saying the suite got smaller.
 */
async function cmdDoctor(argv: string[]): Promise<number> {
  const { opts, command } = splitAtDoubleDash(argv);
  const format = readFormat('doctor', opts, 'text');
  if (format === undefined) return 1;
  if (command.length === 0) {
    err(
      'covsel doctor: expected a runner command after `--`, e.g. covsel doctor -- vitest run\n',
    );
    return 1;
  }
  const cwd = process.cwd();
  const adapter = await resolveAdapter('doctor', opts, cwd);
  if (!adapter) return 1;
  const config = await loadConfigFor(cwd, adapter);
  const requireCheck = hasFlag(opts, 'require');

  // Absent is not "no drift". An adapter with no way to ask its runner leaves
  // the question unanswered, and answering it as agreement would be a green
  // check that never looked at anything.
  if (adapter.listTests === undefined) {
    if (format === 'json') json({ available: false, adapter: adapter.name });
    else {
      out(
        `The ${adapter.name} adapter cannot ask its runner which files it collects, ` +
          'so covsel has nothing to compare its own discovery against.\n' +
          'This check is unavailable here -- it did not pass, it did not run.\n',
      );
    }
    if (requireCheck) {
      err('covsel doctor: --require was given and the check is unavailable\n');
      return 1;
    }
    return 0;
  }

  let collected: string[];
  try {
    collected = await adapter.listTests({ command, cwd, config });
  } catch (e) {
    err(`covsel doctor: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const discovered = discoverTestFiles(cwd, config);
  // A runner that collected nothing has not agreed with anything: against an
  // empty suite the comparison is vacuous, and against a real one every file
  // reads as drift in the wrong direction. Either way the answer is that the
  // question did not get asked properly.
  if (collected.length === 0) {
    if (format === 'json') {
      json({ available: true, collectedCount: 0, discoveredCount: discovered.length });
    } else {
      out(
        `The ${adapter.name} adapter reported that its runner collects no test files ` +
          `at all, while covsel discovers ${discovered.length}.\n` +
          'Nothing can be concluded from that comparison, so it is reported as a ' +
          'failure rather than as two configurations that match.\n',
      );
    }
    return 1;
  }

  const drift = compareSuites(discovered, collected);
  if (format === 'json') {
    json({
      available: true,
      discoveredCount: discovered.length,
      collectedCount: new Set(collected).size,
      unselectable: drift.unselectable,
      unrecordable: drift.unrecordable,
    });
    return hasDrift(drift) ? 1 : 0;
  }

  out(`covsel discovers ${discovered.length} test file(s)\n`);
  out(`${adapter.name} collects  ${new Set(collected).size} test file(s)\n\n`);
  if (!hasDrift(drift)) {
    out('The two agree: every file the runner collects is one covsel discovers.\n');
    return 0;
  }
  // Named separately because the repair differs, and a reader is looking at this
  // precisely because they do not yet know which case they have.
  if (drift.unselectable.length > 0) {
    out(
      `${drift.unselectable.length} file(s) the runner collects that covsel does not discover.\n` +
        'No change can select these, so they stop running the moment covsel decides ' +
        'what runs -- silently, on a green job. Widen `testGlobs` to cover them:\n',
    );
    for (const f of drift.unselectable) out(`  ${f}\n`);
    out('\n');
  }
  if (drift.unrecordable.length > 0) {
    out(
      `${drift.unrecordable.length} file(s) covsel discovers that the runner does not collect.\n` +
        'covsel would ask the runner to record these and the runner was configured ' +
        'not to run them. Add them to `testIgnore`, or collect them:\n',
    );
    for (const f of drift.unrecordable) out(`  ${f}\n`);
    out('\n');
  }
  return 1;
}

async function cmdStatus(argv: string[]): Promise<number> {
  const format = readFormat('status', argv, 'text');
  if (format === undefined) return 1;
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const s = await computeStatus({ cwd, config });
  // The report *is* this command's stdout, unlike the other two where the human
  // lines go to stderr, so here the object replaces it rather than joining it —
  // stdout cannot carry both and still be something a script can read.
  if (format === 'json') {
    json(statusJson(s));
    return 0;
  }
  out(`map:        ${s.mapPath}\n`);
  // A file that is there and cannot be used is neither "yes" nor "no": reported
  // as "no" it sends its reader looking for a map that is sitting at the path
  // printed on the line above.
  out(
    `exists:     ${
      s.mapState === 'usable'
        ? 'yes'
        : s.mapState === 'absent'
          ? 'no'
          : `yes, but not usable (${s.unusableReason ?? 'covsel cannot read it'})`
    }\n`,
  );
  if (s.discoveredTestCount !== undefined) {
    out(
      `discovered: ${s.discoveredTestCount} test file(s)${
        s.discoveredTestCount === 0 ? ' -- check testGlobs' : ''
      }\n`,
    );
  }
  // Only when there are any. A project that told covsel to skip part of its
  // suite should see that said back to it, rather than discovering later that
  // the number it trusts has a subtraction inside it.
  if (s.ignoredTestCount !== undefined && s.ignoredTestCount > 0) {
    out(
      `ignored:    ${s.ignoredTestCount} test file(s) excluded by testIgnore -- ` +
        'never recorded, never selected\n',
    );
  }
  if (s.mapState === 'usable') {
    const ageMin = s.ageMs !== undefined ? Math.round(s.ageMs / 60000) : undefined;
    out(
      `recorded:   ${s.recordedAt ?? 'unknown'}${ageMin !== undefined ? ` (${ageMin}m ago)` : ''}\n`,
    );
    // The tree selection measures change from, which is what makes a restored
    // map mean anything. A map recording none is why the `next:` line below says
    // full run, and reading the two together is how that is diagnosed.
    out(
      `commit:     ${s.commit === undefined ? 'none recorded' : s.commit.slice(0, 12)}\n`,
    );
    out(`granularity:${s.granularity ?? 'unknown'}\n`);
    out(
      `observed:   ${
        s.observed === undefined || s.observed.length === 0
          ? 'nothing (every change forces a full run)'
          : s.observed.join(', ')
      }\n`,
    );
    out(`entries:    ${s.entryCount ?? 0}\n`);
    // Only when there are any: a line reading 0 on every healthy map is noise,
    // and this is worth noticing when it appears.
    if (s.unmeasuredEntryCount !== undefined && s.unmeasuredEntryCount > 0) {
      out(
        `unmeasured: ${s.unmeasuredEntryCount} entry(ies) cover no source -- every ` +
          'test file with one is selected on every run\n',
      );
    }
    // Same rule as the line above: only when there are any. Unlike unmeasured
    // entries this costs nothing at selection time -- they are simply dropped --
    // so it is said as an observation about the map's age, not a warning.
    if (s.staleEntryCount !== undefined && s.staleEntryCount > 0) {
      out(
        `stale:      ${s.staleEntryCount} entry(ies) name a test the suite no longer ` +
          'has -- dropped from every selection, and a sign to record again\n',
      );
    }
    out(`sources:    ${s.coveredFileCount ?? 0}\n`);
    // Only when the sources span more than one top-level directory, because with
    // one the breakdown restates the line above it. Two or more is where the
    // question this answers gets asked: `sources: 29` for a library with 7 says
    // nothing about the 22 that came from `examples/`, and nothing else short of
    // opening the map file would.
    const byDir = Object.entries(s.coveredSourcesByDir ?? {});
    if (byDir.length > 1) {
      for (const [dir, count] of byDir) out(`  ${dir.padEnd(10)}${String(count)}\n`);
    }
    if (s.coveredBlockCount !== undefined) out(`blocks:     ${s.coveredBlockCount}\n`);
    out(
      `sentinels:  ${
        s.changedSentinels.length === 0
          ? 'unchanged'
          : `changed since record: ${s.changedSentinels.join(', ')}`
      }\n`,
    );
  }
  out(
    `next:       ${
      s.nextIsFullRun
        ? `full run (${s.nextFullRunReason ?? 'map cannot be trusted'})`
        : 'select'
    }\n`,
  );
  return 0;
}

/** A unit as the map identifies it: the file, plus the test name when there is one. */
function unitLabel(test: TestId): string {
  return test.name === undefined ? test.file : `${test.file} > ${test.name}`;
}

/**
 * Print an indented list, summarizing the tail rather than filling a terminal
 * with it. A file 400 tests cover is a real answer to a real question, and it is
 * also not one anybody reads 400 lines of — but the count is never elided, so
 * what was left out is visible rather than implied.
 */
function printList(items: string[], all: boolean, indent = '  '): void {
  const shown = all ? items : items.slice(0, EXPLAIN_LIMIT);
  for (const item of shown) out(`${indent}${item}\n`);
  if (shown.length < items.length) {
    out(`${indent}... and ${items.length - shown.length} more (--all)\n`);
  }
}

/** The `path:` .. `alwaysRun:` header: the path, and what decides a change to it. */
function printExplainHeader(r: ExplainResult): void {
  out(`path:       ${r.file}${r.present ? '' : ' (not in the working tree)'}\n`);
  out(`map:        ${r.mapPath}\n`);
  out(`recorded:   ${r.recordedAt ?? 'never'} (${r.granularity ?? 'no'} granularity)\n`);
  // Said before anything about coverage, because it decides what the absence of
  // coverage means: outside the observed scope the map's silence is where the
  // recorder was looking, not a measurement of what ran.
  out(
    r.observed === false
      ? 'observed:   no -- the recording could not observe this path, so a change\n' +
          '            here falls open to a full run\n'
      : 'observed:   yes (the recording could see this path)\n',
  );
  if (r.forcesFullRun !== undefined) {
    out(`full run:   ${r.forcesFullRun.why}\n`);
  }
  if (r.alwaysRun) {
    out('alwaysRun:  yes -- this test runs whatever the diff says\n');
  }
  if (r.excluded) {
    // Discovery never walks these directories, so a test file here is not one
    // waiting to be recorded: it is one covsel will never run or record.
    out('excluded:   yes -- covsel never walks this directory, so nothing here is\n');
    out('            discovered, recorded, or run\n');
  }
}

/** The source view: what covers this file, block by block where the map has them. */
function printCoveredBy(r: ExplainResult, all: boolean): void {
  const source = r.source;
  if (source === undefined) return;
  if (source.coveredBy.length === 0) {
    // Each of these is a different reason for the same empty list, and only the
    // last one means a change here runs nothing.
    out(
      r.observed === false
        ? 'covered by: nothing recorded, and the recording could not observe it\n'
        : r.forcesFullRun?.always === true
          ? 'covered by: no recorded test covers this file -- a change to it runs\n' +
            '            everything anyway, for the reason above\n'
          : 'covered by: no recorded test covers this file -- a change to it selects\n' +
            '            nothing, unless an alwaysRun glob matches it\n',
    );
  } else {
    out(`covered by: ${source.coveredBy.length} test(s)\n`);
    printList(source.coveredBy.map(unitLabel), all);
  }

  if (source.blocks !== undefined) {
    const covered = source.blocks.filter((b) => b.verdict === 'covered');
    const width = Math.max(...source.blocks.map((b) => b.name.length));
    out(
      `blocks:     ${covered.length} of ${source.blocks.length} run by a recorded block\n`,
    );
    // Only `uncovered` says nothing runs this code. The other two say the map
    // cannot tell, and each names what would happen to a change here anyway —
    // reporting either as "covered by nothing" would send a developer looking
    // for the reason their test did not run at the one block that does run it.
    if (source.fileOnly.length > 0) {
      out(
        `            ${source.fileOnly.length} test(s) credit the whole file without ` +
          'recording blocks in it, so a\n            change to any block below runs them\n',
      );
    }
    printList(
      source.blocks.map((b) => {
        const label = b.name.padEnd(width);
        switch (b.verdict) {
          case 'covered':
            return `covered    ${label}  ${b.coveredBy.map(unitLabel).join(', ')}`;
          case 'file-level':
            return `file-level ${label}  no block recorded, but ${source.fileOnly.length} test(s) credit the file`;
          case 'unmatched':
            return `unmatched  ${label}  no recorded block matches it -- it may be one that changed`;
          case 'uncovered':
            return `uncovered  ${label}  no recorded test executes it`;
        }
      }),
      all,
    );
  } else if (source.blocksUnavailable !== undefined) {
    out(`blocks:     not shown -- ${source.blocksUnavailable}\n`);
  }
  if (source.changedBlocks > 0) {
    // A recorded hash the file no longer contains is the very thing selection
    // reads as "this test's code changed", so it is worth naming as drift rather
    // than leaving as a silent gap between the block list and the recording.
    out(
      `drift:      ${source.changedBlocks} recorded block(s) are no longer in this ` +
        'file -- they changed since the recording\n',
    );
  }
}

/** The test view: the units recorded in this file, and what each one covered. */
function printCovers(r: ExplainResult, all: boolean): void {
  const test = r.test;
  if (test === undefined) return;
  if (test.unrecorded) {
    out(
      r.excluded
        ? 'covers:     nothing recorded -- and nothing will be, since covsel never\n' +
            '            walks this directory\n'
        : 'covers:     nothing recorded -- the map does not record this test, so it\n' +
            '            always runs until it is\n',
    );
    return;
  }
  out(`covers:     ${test.units.length} recorded unit(s)\n`);
  if (test.unmeasured) {
    // The recorded-but-blind case. Without this the unit list below reads as a
    // measurement -- "0 source(s)" beside a healthy map -- and the reader has
    // no way to tell it from a test that really executes nothing.
    //
    // "selected on every run" only holds for a file selection can still find:
    // it draws these from discovery, so an entry outliving its test file, or
    // one left behind by a narrowed `testGlobs`, selects nothing at all.
    out(
      r.present
        ? '            a unit here covers no source, so nothing the map holds can\n' +
            '            narrow this file and it is selected on every run\n'
        : '            a unit here covers no source, and the file is not in the\n' +
            '            working tree, so there is nothing left for covsel to run\n',
    );
  }
  const shown = all ? test.units : test.units.slice(0, EXPLAIN_LIMIT);
  for (const unit of shown) {
    const name = unit.test.name ?? '(whole file)';
    out(`  ${name} -- ${unit.sources.length} source(s)\n`);
    printList(unit.sources, all, '      ');
  }
  if (shown.length < test.units.length) {
    out(`  ... and ${test.units.length - shown.length} more unit(s) (--all)\n`);
  }
}

async function cmdExplain(argv: string[]): Promise<number> {
  const target = argv.find((a) => !a.startsWith('--'));
  if (target === undefined) {
    err('covsel explain: expected a path, e.g. covsel explain src/thing.ts\n');
    return 1;
  }
  const all = hasFlag(argv, 'all');
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const result = await explainPath({ cwd, config, path: target });
  if (!result.ok) {
    err(`covsel explain: ${result.error ?? `cannot explain ${target}`}\n`);
    return 1;
  }

  if (result.mapState !== 'usable') {
    // Nothing to index, which is an answer rather than an error: with no map
    // every test runs, so nothing about this path is being decided by coverage.
    // Which kind of nothing still matters — a rejected map is a file to go and
    // re-record, not one to go looking for.
    out(`path:       ${result.file}\n`);
    out(
      `map:        ${result.mapPath} ${
        result.mapState === 'absent' ? '(none recorded)' : '(not usable)'
      }\n`,
    );
    out(
      `nothing to explain -- ${result.noMapReason ?? 'no usable map recorded'}, so\n` +
        'the next selection is a full run\n',
    );
    return 0;
  }
  printExplainHeader(result);
  printCoveredBy(result, all);
  printCovers(result, all);
  // Last, and always: everything above is what the map holds about this path,
  // and none of it narrows anything while the next selection is a full run. A
  // report that ended at "no recorded test covers this file" would read as
  // "nothing runs" in exactly the states where everything does.
  out(
    result.nextIsFullRun === true
      ? `next:       full run (${result.nextFullRunReason ?? 'map cannot be trusted'})\n`
      : 'next:       select\n',
  );
  return 0;
}

async function cmdMerge(argv: string[]): Promise<number> {
  if (argv.at(-1) === '--out') {
    err('covsel merge: --out needs a file path\n');
    return 1;
  }
  const outPath = flag(argv, 'out');
  const inputs = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    return argv[i - 1] !== '--out';
  });
  if (inputs.length === 0) {
    err(
      'covsel merge: expected shard map files, e.g. covsel merge shard-*/map.json --out .covsel/map.json\n',
    );
    return 1;
  }

  const maps: CoverageMap[] = [];
  for (const file of inputs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      err(`covsel merge: cannot read ${file}\n`);
      return 1;
    }
    if (!isUsableMap(parsed)) {
      err(`covsel merge: ${file} is not a usable map (wrong schema version?)\n`);
      return 1;
    }
    maps.push(parsed);
  }

  let merged: CoverageMap;
  try {
    merged = mergeMaps(maps);
  } catch (e) {
    err(`covsel merge: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const target = outPath ?? join(cwd, config.store.dir, 'map.json');
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`);
  } catch (e) {
    err(
      `covsel merge: cannot write ${target}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
  err(
    `covsel merge: merged ${maps.length} maps into ${target} ` +
      `(${merged.entries.length} entries, granularity ${merged.granularity})\n`,
  );
  if (merged.commit === undefined) {
    err(
      'covsel merge: shards disagree on the recorded commit; the merged map ' +
        'records none, so the next selection will be a full run\n',
    );
  }
  if (merged.observed.length === 0) {
    err(
      'covsel merge: shards disagree on what they could observe; the merged map ' +
        'claims nothing, so the next selection will be a full run\n',
    );
  }
  return 0;
}

/** The archive directory for this invocation: `--archive`, or the configured one. */
function archiveDir(opts: string[], cwd: string, config: CovselConfig): string {
  const flagged = flag(opts, 'archive');
  return flagged === undefined ? archiveDirFor(cwd, config) : resolve(cwd, flagged);
}

async function cmdPublish(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const keepRaw = flag(argv, 'keep');
  const keep = keepRaw === undefined ? undefined : Number(keepRaw);
  if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
    err('covsel publish: --keep needs a whole number of maps, at least 1\n');
    return 1;
  }

  const store = new LocalStore({ cwd, dir: config.store.dir });
  const map = await store.read();
  if (map === undefined) {
    // A map that is present but rejected is a different problem from no map at
    // all, and after a schema bump it is the common one. Pointing at "record
    // first" would be right by accident and misleading on the way there.
    err(
      existsSync(store.path())
        ? `covsel publish: the map at ${store.path()} is not usable ` +
            `(recorded by a different covsel version?) -- re-record it\n`
        : `covsel publish: no map at ${store.path()} -- run covsel record first\n`,
    );
    return 1;
  }

  const dir = archiveDir(argv, cwd, config);
  const result = publishMap({ dir, map, ...(keep !== undefined ? { keep } : {}) });
  if (!result.ok) {
    err(`covsel publish: ${result.reason}\n`);
    return 1;
  }
  err(
    `covsel publish: archived ${result.commit.slice(0, 12)} ` +
      `(${map.entries.length} entries) to ${result.file}\n`,
  );
  if (result.pruned.length > 0) {
    err(
      `covsel publish: pruned ${result.pruned.length} older map(s): ` +
        `${result.pruned.map((c) => c.slice(0, 12)).join(', ')}\n`,
    );
  }
  return 0;
}

async function cmdFetch(argv: string[]): Promise<number> {
  const format = readFormat('fetch', argv, 'text');
  if (format === undefined) return 1;
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const dir = archiveDir(argv, cwd, config);
  const result = await fetchMap({
    cwd,
    dir,
    storeDir: config.store.dir,
    ...(hasFlag(argv, 'force') ? { force: true } : {}),
  });

  // Every candidate that was passed over is a map someone published expecting it
  // to be used, so the reason it was not is worth the line in a CI log.
  for (const skipped of result.skipped) {
    err(`covsel fetch: skipped ${skipped.commit.slice(0, 12)} -- ${skipped.reason}\n`);
  }
  // Additive, not instead of: everything this command says already goes to
  // stderr, so a job reading the object keeps the log a human reads beside it.
  if (format === 'json') {
    json(
      result.ok
        ? {
            ok: true,
            commit: result.commit,
            how: result.how,
            recordedAt: result.recordedAt,
            mapPath: result.mapPath,
            skipped: result.skipped,
          }
        : { ok: false, reason: result.reason, skipped: result.skipped },
    );
  }

  if (!result.ok) {
    err(`covsel fetch: ${result.reason}\n`);
    // Not finding a map is the fail-open path, not a failure: the tests still
    // have to run, and they run in full. A caller that would rather know says so.
    if (hasFlag(argv, 'require')) return 1;
    err('covsel fetch: the next selection will be a full run\n');
    return 0;
  }

  err(
    `covsel fetch: installed the map recorded at ${result.commit.slice(0, 12)}` +
      `${result.recordedAt !== undefined ? ` (${result.recordedAt})` : ''} to ${result.mapPath}\n`,
  );
  if (result.how === 'present') {
    // Sound, but the diff is two diverged trees against each other rather than a
    // branch's own work, so the selection is wider than it looks.
    err(
      'covsel fetch: that commit is not an ancestor of HEAD, so the diff spans ' +
        'both trees and selection will be wider than usual\n',
    );
  }
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === undefined || cmd === '-h' || cmd === '--help') {
    out(HELP);
    return 0;
  }
  if (cmd === '-v' || cmd === '--version') {
    out(`${VERSION}\n`);
    return 0;
  }
  switch (cmd) {
    case 'init':
      return cmdInit(rest);
    case 'record':
      return cmdRecord(rest);
    case 'affected':
      return cmdAffected(rest);
    case 'run':
      return cmdRun(rest);
    case 'watch':
      return cmdWatch(rest);
    case 'status':
      return cmdStatus(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'explain':
      return cmdExplain(rest);
    case 'merge':
      return cmdMerge(rest);
    case 'publish':
      return cmdPublish(rest);
    case 'fetch':
      return cmdFetch(rest);
    default:
      err(`covsel: unknown command '${cmd}'. Run covsel --help.\n`);
      return 1;
  }
}
