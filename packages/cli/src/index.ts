import {
  ADAPTERS,
  type AdapterName,
  type AffectedResult,
  computeStatus,
  type CovselConfig,
  createGenericRecorder,
  type InitDiagnostics,
  initProject,
  isAdapterName,
  loadConfig,
  MAP_SCHEMA_VERSION,
  recordMap,
  runAffected,
  selectAffected,
} from '@covsel/core';
import { createVitestRecorder } from '@covsel/adapter-vitest';
import { createNodeTestRecorder, runNodeTestSelection } from '@covsel/adapter-node-test';

const HELP = `covsel — runtime-coverage test impact analysis for any JS/TS runner

Usage:
  covsel init [--adapter <name>]                   Detect the runner and write a config
  covsel record [--adapter <name>] -- <command>   Run the suite and build the map
  covsel affected [--since <ref>] [--format files] Print tests the diff can affect
  covsel run -- <command>                          Run only the affected tests
  covsel status                                    Show map age, size, and next action
  covsel --help                                    Show this help
  covsel --version                                 Show version

init records which adapter observes this project, so record and run need no
flag. record wraps a runner and observes each test file in its own process to learn
which sources it executes. affected prints those test files a diff can affect,
so \`<runner> $(covsel affected)\` runs only what is needed.

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

/**
 * The adapter for this invocation: the flag when given, otherwise the one
 * `covsel init` persisted. Validated here so a typo in either place is a loud
 * error rather than a silent fall back to a recorder that cannot observe this
 * project.
 */
function resolveAdapter(opts: string[], config: CovselConfig): AdapterName | undefined {
  const requested = flag(opts, 'adapter');
  const value = requested ?? config.adapter;
  if (isAdapterName(value)) return value;
  const source = requested === undefined ? 'in your covsel config' : 'from --adapter';
  err(`covsel: unknown adapter '${value}' ${source} (expected ${ADAPTERS.join(', ')})\n`);
  return undefined;
}

function reportSelection(result: AffectedResult): void {
  if (result.fullRun) {
    err(`covsel: full run — ${result.reason ?? 'map cannot be trusted for this diff'}\n`);
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

async function cmdInit(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const adapter = flag(argv, 'adapter');
  const result = await initProject({
    cwd,
    covselVersion: VERSION,
    ...(adapter !== undefined ? { adapter } : {}),
  });

  for (const warning of result.warnings) {
    if (result.outcome !== 'unknown-adapter') err(`covsel init: warning — ${warning}\n`);
  }

  switch (result.outcome) {
    case 'unknown-adapter':
      err(`covsel init: ${result.warnings.join('; ')}\n`);
      return 1;

    case 'configured':
      out(`covsel init: wrote ${result.configPath} (adapter: ${result.adapter})\n`);
      if (result.gitignoreUpdated) {
        out(`covsel init: added the map directory to ${result.gitignorePath}\n`);
      }
      if (result.commands) printNextSteps(result.commands);
      return 0;

    case 'already-configured':
      out(
        `covsel init: ${result.configPath} already exists (adapter: ${result.adapter}) — left as is\n`,
      );
      if (result.gitignoreUpdated) {
        out(`covsel init: added the map directory to ${result.gitignorePath}\n`);
      }
      if (result.commands) printNextSteps(result.commands);
      return 0;

    case 'unsupported-runner': {
      const names = result.detected.map((r) => r.name).join(', ');
      err(
        `covsel init: ${names} transforms sources before executing them, and no covsel ` +
          `adapter can observe it yet. Wrapping it generically would record a map in ` +
          `which no test covers your sources — so a change to them would select ` +
          `nothing. Keep running this suite in full.\n`,
      );
      err(`\nTracking: ${result.reportUrl}\n`);
      err(
        `\nIf you know better, covsel init --adapter <${ADAPTERS.join('|')}> writes the ` +
          `config anyway.\n`,
      );
      return 1;
    }

    case 'undetected':
      err('covsel init: no supported test runner detected in this project.\n');
      err(
        `\nIf covsel should support your runner, please open an adapter request:\n  ${result.reportUrl}\n`,
      );
      printDiagnostics(result.diagnostics);
      err(
        `\nTo configure covsel now, pass the adapter yourself:\n  covsel init --adapter <${ADAPTERS.join('|')}>\n`,
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
  const config = await loadConfig(cwd);
  const adapter = resolveAdapter(opts, config);
  if (adapter === undefined) return 1;

  const recorder =
    adapter === 'vitest'
      ? createVitestRecorder({ command, cwd, config })
      : adapter === 'node-test'
        ? createNodeTestRecorder({ command, cwd, config })
        : createGenericRecorder({ command, cwd, config });

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
  const config = await loadConfig(cwd);
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
  const since = flag(opts, 'since');
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const adapter = resolveAdapter(opts, config);
  if (adapter === undefined) return 1;

  if (adapter === 'node-test') {
    const selection = await selectAffected({ cwd, config, ...(since ? { since } : {}) });
    reportSelection(selection);
    if (selection.fullRun) {
      return runAffected({ cwd, config, command, ...(since ? { since } : {}) });
    }
    if (selection.selected.length === 0) return 0;
    return runNodeTestSelection({ selected: selection.selected, command, cwd });
  }

  return runAffected(
    { cwd, config, command, ...(since ? { since } : {}) },
    reportSelection,
  );
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
    case 'status':
      return cmdStatus();
    default:
      err(`covsel: unknown command '${cmd}'. Run covsel --help.\n`);
      return 1;
  }
}
