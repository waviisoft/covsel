import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  type Adapter,
  type AffectedResult,
  computeStatus,
  type CoverageMap,
  type CovselConfig,
  type InitDiagnostics,
  initProject,
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
  covsel init [--adapter <name>]                   Detect the runner and write a config
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
  --debounce <ms>    watch: quiet period after a change before running (default 200)
  --record           watch: re-record the map after a run that passes
  --no-initial-run   watch: wait for the first change instead of running at startup

init names the adapter for the runner it finds and writes it to the config, so
later commands need no --adapter. record wraps a runner and observes each test
file in its own process to learn which sources it executes. affected prints those test files a diff can affect,
so \`<runner> $(covsel affected)\` runs only what is needed. watch drives the same
selection continuously, running the affected tests on every save.

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

async function cmdInit(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const adapter = flag(argv, 'adapter');
  const result = await initProject({
    cwd,
    covselVersion: VERSION,
    isAdapterInstalled: (name) => adapterIsInstalled(name, cwd),
    ...(adapter !== undefined ? { adapter } : {}),
  });

  for (const warning of result.warnings) {
    err(`covsel init: warning — ${warning}\n`);
  }

  switch (result.outcome) {
    case 'configured':
    case 'already-configured': {
      out(
        result.outcome === 'configured'
          ? `covsel init: wrote ${result.configPath} (adapter: ${result.adapter})\n`
          : `covsel init: ${result.configPath} already exists (adapter: ${result.adapter ?? 'unset'}) — left as is\n`,
      );
      if (result.gitignoreUpdated) {
        out(`covsel init: added the map directory to ${result.gitignorePath}\n`);
      }
      // covsel ships no adapters, so naming the right one is only half the
      // answer: without the package, the first record would fail on a name that
      // is now in the config and looks settled.
      if (result.adapter !== undefined && result.adapterInstalled === false) {
        out(
          `\nInstall the adapter:\n  npm install --save-dev ${adapterSpecifiers(result.adapter)[0]}\n`,
        );
      }
      if (result.commands) printNextSteps(result.commands);
      return 0;
    }

    case 'unsupported-runner': {
      const names = result.detected.map((r) => r.name).join(', ');
      err(
        `covsel init: no adapter records ${names} yet, so covsel cannot select its ` +
          `tests. Keep running that suite in full.\n`,
      );
      err(`\nTracking: ${result.reportUrl}\n`);
      err(
        `\nIf an adapter for it exists under another name, name it yourself:\n` +
          `  covsel init --adapter <name>\n`,
      );
      return 1;
    }

    case 'undetected':
      err('covsel init: no test runner detected in this project.\n');
      err(
        `\nIf covsel should support your runner, please open an adapter request:\n  ${result.reportUrl}\n`,
      );
      printDiagnostics(result.diagnostics);
      err(
        `\nTo configure covsel now, name the adapter yourself:\n  covsel init --adapter <name>\n`,
      );
      return 1;
  }
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
  const recorder = adapter.createRecorder({ command, cwd, config });

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
        const result = await recordMap({
          cwd,
          config,
          recorder: adapter.createRecorder({ command, cwd, config }),
        });
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
