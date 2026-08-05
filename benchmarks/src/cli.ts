import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverTestFiles, resolveConfig } from '@covsel/core';

import { collectOutcomes } from './outcomes.js';
import { prepareClone, recordMap } from './prepare.js';
import { parseProject } from './project.js';
import { measure, type ReplayResult } from './replay.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const COVSEL_BIN = join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js');

const USAGE = `covsel benchmarks -- replay merged changes and measure what selection saved

Usage:
  replay --project <file> --head <ref> [--head <ref>...] [options]

Options:
  --project <file>   Project definition JSON (see benchmarks/projects/)
  --head <ref>       A commit to replay onto the project's pinned base. Repeatable.
  --work <dir>       Where clones live (default: benchmarks/.work)
  --out <file>       Append JSONL results here (default: benchmarks/results/<name>.jsonl)
  --repetitions <n>  Timed runs per command; the median is reported (default: 1)
  --record-timeout <ms>  Ceiling on recording, which waits on one process per
                     test file and so stalls on a test that hangs (default: 45m)

The project's pinned ref is the base: the map is recorded there once and carried
across to each head, which is what CI does with a map published from the default
branch. Build the CLI first (pnpm build).
`;

const log = (message: string): void => void process.stderr.write(`${message}\n`);

export function flags(argv: string[], name: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${name}`) continue;
    const value = argv[i + 1];
    // A following `--flag` is the next option, not this one's value. Swallowing
    // it would leave `--head --repetitions 3` replaying a commit called
    // "--repetitions" and silently drop the option the user did pass.
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} needs a value`);
    }
    found.push(value);
  }
  return found;
}

export function flag(argv: string[], name: string): string | undefined {
  return flags(argv, name)[0];
}

/**
 * A positive number, or a refusal. A mistyped count that silently became NaN
 * would run every timed command zero times and report a wall-clock of nothing,
 * which reads as an extraordinary result rather than as the mistake it is.
 */
export function positiveNumber(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const DEFAULT_RECORD_TIMEOUT_MS = 45 * 60 * 1000;

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const projectPath = flag(argv, 'project');
  if (projectPath === undefined) {
    log('replay: --project is required');
    return 1;
  }
  const heads = flags(argv, 'head');
  if (heads.length === 0) {
    log('replay: at least one --head is required');
    return 1;
  }
  if (!existsSync(COVSEL_BIN)) {
    log(`replay: ${COVSEL_BIN} is missing -- run pnpm build first`);
    return 1;
  }

  const project = parseProject(
    JSON.parse(readFileSync(projectPath, 'utf8')),
    projectPath,
  );
  const work = flag(argv, 'work') ?? join(REPO_ROOT, 'benchmarks', '.work');
  const out =
    flag(argv, 'out') ??
    join(REPO_ROOT, 'benchmarks', 'results', `${project.name}.jsonl`);
  const repetitions = positiveNumber(argv, 'repetitions', 1);
  const recordTimeoutMs = positiveNumber(
    argv,
    'record-timeout',
    DEFAULT_RECORD_TIMEOUT_MS,
  );

  const repo = prepareClone({
    project,
    work,
    packagesRoot: join(REPO_ROOT, 'packages'),
    log,
  });
  const recordMs = recordMap({
    project,
    repo,
    covselBin: COVSEL_BIN,
    timeoutMs: recordTimeoutMs,
    log,
  });

  // Collected while the checkout is still on the base, since establishing what
  // each test did before the change is the only way to know which ones the
  // change altered.
  log('collecting base outcomes (one process per test file)');
  const config = resolveConfig(project.covsel);
  const baseOutcomes = collectOutcomes({
    command: project.runner,
    cwd: repo,
    files: discoverTestFiles(repo, config),
  });

  mkdirSync(dirname(out), { recursive: true });
  const results: ReplayResult[] = [];
  for (const head of heads) {
    log(`replaying ${head}`);
    const result = measure({
      project,
      repo,
      base: project.ref,
      head,
      covselBin: COVSEL_BIN,
      recordMs,
      baseOutcomes,
      repetitions,
      onEvent: (event) => log(`  ${event.step}${event.detail ? ` ${event.detail}` : ''}`),
    });
    appendFileSync(out, `${JSON.stringify(result)}\n`);
    results.push(result);
    log(
      `  selected ${result.selectedTests}/${result.totalTests}` +
        ` (${(result.selectionRatio * 100).toFixed(0)}%)` +
        `, misses ${result.misses.length}` +
        // Named on every line, not only when non-zero: a reader comparing miss
        // counts needs to know how many files the oracle could not score.
        `, unscorable ${result.unscorable.length}`,
    );
  }

  const missed = results.filter((r) => r.misses.length > 0);
  if (missed.length > 0) {
    log(`\nFAIL: ${missed.length} change(s) had a test whose outcome moved but was`);
    log('not selected. That is a skipped test, which outranks every other result.');
    for (const result of missed) log(`  ${result.head}: ${result.misses.join(', ')}`);
    return 1;
  }
  log(`\nwrote ${results.length} result(s) to ${out}`);
  return 0;
}

// Only when run as a command. Imported -- as the tests import it -- the module
// must define its argument parsing without also executing a replay.
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(HERE, 'cli.js')
) {
  try {
    const exitCode = main();
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    // A replay clones repositories and runs whole suites, so a failure part way
    // through is normal enough to deserve a readable line rather than a stack.
    log(`replay: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
