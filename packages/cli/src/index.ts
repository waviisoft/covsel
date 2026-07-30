import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  type Adapter,
  type AffectedResult,
  computeStatus,
  type CoverageMap,
  type CovselConfig,
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
  MAP_SCHEMA_VERSION,
  mergeMaps,
  recordMap,
  resolveConfigFor,
  runAffected,
  runAffectedSelection,
  selectAffected,
  watchAffected,
  type WatchEvent,
} from '@covsel/core';

import {
  AdapterResolutionError,
  adapterSpecifiers,
  DEFAULT_ADAPTER,
  loadAdapter,
} from './adapters.js';

const HELP = `covsel -- runtime-coverage test impact analysis for any JS/TS runner

Usage:
  covsel init [--adapter <name>] [--auto-approve] [--no-install]
                                                   Set covsel up for this project
  covsel record [--adapter <name>] -- <command>   Run the suite and build the map
  covsel affected [--since <ref>] [--format files] Print tests the diff can affect
  covsel run -- <command>                          Run only the affected tests
  covsel watch -- <command>                        Rerun affected tests as you edit
  covsel status                                    Show map age, size, and next action
  covsel merge <maps...> [--out <file>]            Merge CI shard maps into one
  covsel --help                                    Show this help
  covsel --version                                 Show version

Options:
  --adapter <name>   Installed adapter package for record/affected/run/watch
                     (default: the config's adapter, else '${DEFAULT_ADAPTER}';
                     adapters install separately)
  --since <ref>      Diff against <ref> instead of the commit the map records
  --auto-approve     init: carry the plan out without asking (required with no
                     terminal, since init changes the project)
  --no-install       init: plan to configure without installing, and print the
                     install command you will need
  --debounce <ms>    watch: quiet period after a change before running (default 200)
  --record           watch: re-record the map after a run that passes
  --no-initial-run   watch: wait for the first change instead of running at startup

init detects the runner, shows what it would change, and on your say-so installs
its adapter and writes that adapter to the config, so later commands need no
--adapter. record wraps a runner and observes each test file in its own process
to learn which sources it executes. affected prints those test files a diff can
affect, so \`<runner> $(covsel affected)\` runs only what is needed. watch drives
the same selection continuously, running the affected tests on every save.

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
}): void {
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
  return 0;
}

async function cmdAffected(argv: string[]): Promise<number> {
  const format = flag(argv, 'format') ?? 'files';
  if (format !== 'files') {
    err(
      `covsel affected: unsupported --format '${format}' (only 'files' is available)\n`,
    );
    return 1;
  }
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
              reason: `${result.failures.length} test file(s) failed to record`,
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

async function cmdStatus(): Promise<number> {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const s = await computeStatus({ cwd, config });
  out(`map:        ${s.mapPath}\n`);
  out(`exists:     ${s.exists ? 'yes' : 'no'}\n`);
  if (s.exists) {
    const ageMin = s.ageMs !== undefined ? Math.round(s.ageMs / 60000) : undefined;
    out(
      `recorded:   ${s.recordedAt ?? 'unknown'}${ageMin !== undefined ? ` (${ageMin}m ago)` : ''}\n`,
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
    out(`sources:    ${s.coveredFileCount ?? 0}\n`);
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
      return cmdStatus();
    case 'merge':
      return cmdMerge(rest);
    default:
      err(`covsel: unknown command '${cmd}'. Run covsel --help.\n`);
      return 1;
  }
}
