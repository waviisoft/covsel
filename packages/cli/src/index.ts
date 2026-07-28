import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  type AffectedResult,
  computeStatus,
  type CoverageMap,
  type CovselConfig,
  loadConfig,
  isUsableMap,
  loadRawConfig,
  MAP_SCHEMA_VERSION,
  mergeMaps,
  recordMap,
  resolveConfig,
  runSelectionCommand,
  selectAffected,
  watchAffected,
  type WatchEvent,
} from '@covsel/core';

import {
  ADAPTERS,
  type AdapterEntry,
  adapterNameList,
  DEFAULT_ADAPTER,
} from './adapters.js';

const HELP = `covsel — runtime-coverage test impact analysis for any JS/TS runner

Usage:
  covsel record [--adapter <name>] -- <command>   Run the suite and build the map
  covsel affected [--since <ref>] [--format files] Print tests the diff can affect
  covsel run -- <command>                          Run only the affected tests
  covsel watch -- <command>                        Rerun affected tests as you edit
  covsel status                                    Show map age, size, and next action
  covsel merge <maps...> [--out <file>]            Merge CI shard maps into one
  covsel --help                                    Show this help
  covsel --version                                 Show version

Options:
  --adapter <name>   Runner adapter for record/run/watch (${adapterNameList()})
  --since <ref>      Diff against <ref> instead of the commit the map records
  --debounce <ms>    watch: quiet period after a change before running (default 200)
  --record           watch: re-record the map after a run that passes
  --no-initial-run   watch: wait for the first change instead of running at startup

record wraps a runner and observes each test file in its own process to learn
which sources it executes. affected prints those test files a diff can affect,
so \`<runner> $(covsel affected)\` runs only what is needed. watch drives the same
selection continuously, running the affected tests on every save.

covsel never skips a test whose behavior your change could alter — and when it
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
 * Load config, letting the chosen adapter supply the test globs when the project
 * has not set them, so a runner whose tests are not `*.test.*` sources still
 * works with no configuration.
 */
async function loadConfigFor(cwd: string, adapter: string): Promise<CovselConfig> {
  const raw = await loadRawConfig(cwd);
  const globs = ADAPTERS[adapter]?.defaultTestGlobs;
  if (globs !== undefined && raw.testGlobs === undefined) {
    return resolveConfig({ ...raw, testGlobs: globs });
  }
  return resolveConfig(raw);
}

function reportSelection(result: AffectedResult): void {
  if (result.fullRun) {
    err(`covsel: full run — ${result.reason ?? 'map cannot be trusted for this diff'}\n`);
  } else if (result.tests.length === 0) {
    err('covsel: no affected tests\n');
  }
}

/**
 * Hand a selection to the runner. Adapters that record individual tests narrow
 * below file level through the runner's own filtering; the rest get the file
 * list. A full run bypasses both — the runner is invoked with no filter, so its
 * own full suite is what runs.
 */
function runSelected(
  entry: AdapterEntry,
  cwd: string,
  command: string[],
  selection: AffectedResult,
): number {
  if (!selection.fullRun && entry.runSelection && selection.selected.length > 0) {
    return entry.runSelection({ selected: selection.selected, command, cwd });
  }
  return runSelectionCommand({ cwd, command, selection });
}

/** Resolve `--adapter`, reporting the valid names when it is not one of them. */
function resolveAdapter(
  cmd: string,
  opts: string[],
): { name: string; entry: AdapterEntry } | undefined {
  const name = flag(opts, 'adapter') ?? DEFAULT_ADAPTER;
  const entry = ADAPTERS[name];
  if (!entry) {
    err(`covsel ${cmd}: unknown adapter '${name}' (expected ${adapterNameList()})\n`);
    return undefined;
  }
  return { name, entry };
}

async function cmdRecord(argv: string[]): Promise<number> {
  const { opts, command } = splitAtDoubleDash(argv);
  if (command.length === 0) {
    err(
      'covsel record: expected a runner command after `--`, e.g. covsel record -- vitest run\n',
    );
    return 1;
  }
  const adapter = resolveAdapter('record', opts);
  if (!adapter) return 1;
  const cwd = process.cwd();
  const config = await loadConfigFor(cwd, adapter.name);
  const recorder = adapter.entry.createRecorder({ command, cwd, config });

  const result = await recordMap({
    cwd,
    config,
    recorder,
    onEvent: (e) => {
      if (e.kind === 'recorded') {
        err(`  recorded ${e.file} (${e.tests} tests, ${e.sources} sources)\n`);
      } else err(`  FAILED   ${e.file}: ${e.reason}\n`);
    },
  });

  if (!result.ok) {
    err(
      `covsel record: ${result.failures.length} test file(s) failed; map not written ` +
        `(a partial map cannot be trusted).\n`,
    );
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
  const since = flag(argv, 'since');
  const cwd = process.cwd();
  const config = await loadConfigFor(cwd, flag(argv, 'adapter') ?? DEFAULT_ADAPTER);
  const result = await selectAffected({ cwd, config, ...(since ? { since } : {}) });
  reportSelection(result);
  if (result.tests.length > 0) out(`${result.tests.join('\n')}\n`);
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
  const adapter = resolveAdapter('run', opts);
  if (!adapter) return 1;
  const since = flag(opts, 'since');
  const cwd = process.cwd();
  const config = await loadConfigFor(cwd, adapter.name);

  const selection = await selectAffected({ cwd, config, ...(since ? { since } : {}) });
  reportSelection(selection);
  return runSelected(adapter.entry, cwd, command, selection);
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
  const adapter = resolveAdapter('watch', opts);
  if (!adapter) return 1;

  const debounceRaw = flag(opts, 'debounce');
  const debounceMs = debounceRaw === undefined ? undefined : Number(debounceRaw);
  if (debounceMs !== undefined && (!Number.isFinite(debounceMs) || debounceMs < 0)) {
    err(`covsel watch: --debounce needs a non-negative number of milliseconds\n`);
    return 1;
  }

  const since = flag(opts, 'since');
  const cwd = process.cwd();
  const config = await loadConfigFor(cwd, adapter.name);

  // Re-recording is opt-in: it re-runs the whole suite, and a map that only ages
  // over-selects, so the default trades precision for the latency watch exists
  // to give.
  const record = hasFlag(opts, 'record')
    ? async (): Promise<{ ok: boolean; reason?: string }> => {
        const result = await recordMap({
          cwd,
          config,
          recorder: adapter.entry.createRecorder({ command, cwd, config }),
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
      run: (selection) => runSelected(adapter.entry, cwd, command, selection),
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
