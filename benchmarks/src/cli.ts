import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverTestFiles, resolveConfig } from '@covsel/core';

import { collectOutcomes } from './outcomes.js';
import { type BenchmarkProject, parseProject } from './project.js';
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

function flags(argv: string[], name: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      const value = argv[i + 1];
      if (value !== undefined) found.push(value);
    }
  }
  return found;
}

function flag(argv: string[], name: string): string | undefined {
  return flags(argv, name)[0];
}

/**
 * A positive number, or a refusal. A mistyped count that silently became NaN
 * would run every timed command zero times and report a wall-clock of nothing,
 * which reads as an extraordinary result rather than as the mistake it is.
 */
function positiveNumber(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function must(command: string[], cwd: string, what: string): void {
  const [bin, ...rest] = command;
  if (bin === undefined) throw new Error(`${what}: empty command`);
  const result = spawnSync(bin, rest, { cwd, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${what} failed (exit ${result.status ?? 'signal'})`);
  }
}

/**
 * Link the workspace build into the clone rather than installing from a
 * registry, because these packages are not published yet. The clone resolves
 * `@covsel/*` the same way a real project would; only where the files came from
 * differs.
 */
function linkCovselInto(repo: string, project: BenchmarkProject): void {
  const scope = join(repo, 'node_modules', '@covsel');
  mkdirSync(scope, { recursive: true });
  const packages = ['core', project.adapter.replace(/^@covsel\//, '')];
  for (const name of packages) {
    const target = join(REPO_ROOT, 'packages', name);
    if (!existsSync(target)) throw new Error(`no workspace package for ${name}`);
    const link = join(scope, name);
    if (!existsSync(link)) {
      spawnSync('ln', ['-sfn', target, link], { encoding: 'utf8' });
    }
  }
}

function prepare(project: BenchmarkProject, work: string): string {
  const repo = join(work, project.name);
  if (!existsSync(repo)) {
    mkdirSync(work, { recursive: true });
    log(`cloning ${project.repo}`);
    must(
      ['git', 'clone', '--quiet', `https://github.com/${project.repo}.git`, repo],
      work,
      'clone',
    );
  }
  log(`checking out ${project.ref}`);
  must(['git', 'checkout', '--quiet', project.ref], repo, 'checkout base');

  log('installing project dependencies');
  must(project.install, repo, 'install');
  linkCovselInto(repo, project);

  writeFileSync(
    join(repo, 'covsel.json'),
    `${JSON.stringify(project.covsel, null, 2)}\n`,
  );
  return repo;
}

const DEFAULT_RECORD_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Record the map, with recording's progress passed straight through and a
 * ceiling on the whole thing.
 *
 * Recording drives one process per test file and waits for each, so a test file
 * that hangs stalls the run for as long as it is allowed to. A real repository
 * in the slate turned out to have one, which is why both halves matter here:
 * inherited output names the file recording is waiting on, and the ceiling stops
 * a stalled run from consuming a machine indefinitely.
 */
function recordMap(project: BenchmarkProject, repo: string, timeoutMs: number): number {
  log('recording the map');
  const started = process.hrtime.bigint();
  const result = spawnSync(
    process.execPath,
    [COVSEL_BIN, 'record', '--adapter', project.adapterName, '--', ...project.runner],
    { cwd: repo, encoding: 'utf8', stdio: 'inherit', timeout: timeoutMs },
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.signal !== null) {
    throw new Error(
      `record was killed (${result.signal}) after ${(ms / 1000).toFixed(0)}s -- ` +
        `the last file it named above is where it stopped. Raise --record-timeout ` +
        `if the suite is simply slow.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`record failed (exit ${result.status ?? 'unknown'})`);
  }
  log(`recorded in ${(ms / 1000).toFixed(1)}s`);
  return ms;
}

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

  const repo = prepare(project, work);
  const recordMs = recordMap(project, repo, recordTimeoutMs);

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
        `, misses ${result.misses.length}`,
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

try {
  const exitCode = main();
  if (exitCode !== 0) process.exitCode = exitCode;
} catch (error) {
  // A replay clones repositories and runs whole suites, so a failure part way
  // through is normal enough to deserve a readable line rather than a stack.
  log(`replay: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
