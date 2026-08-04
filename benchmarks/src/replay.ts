import { spawnSync } from 'node:child_process';

import {
  discoverTestFiles,
  LocalStore,
  matchesAny,
  resolveConfig,
  type CovselConfig,
} from '@covsel/core';

import {
  breakEvenRuns,
  changedOutcomes,
  median,
  outcomeMisses,
  type Outcomes,
  selectionRatio,
  splitSelection,
  stratumOf,
  type Stratum,
  wallClockRatio,
} from './metrics.js';
import { collectOutcomes } from './outcomes.js';
import type { BenchmarkProject } from './project.js';

export interface ReplayEvent {
  step: 'checkout' | 'affected' | 'selected-run' | 'full-run' | 'head-outcomes' | 'done';
  detail?: string;
}

/** One replayed change, as written to the results file. */
export interface ReplayResult {
  project: string;
  repo: string;
  base: string;
  head: string;
  /** Files the change touched, and which size bucket that puts it in. */
  changedFiles: number;
  stratum: Stratum;
  /** Test files discovered at the head. */
  totalTests: number;
  /** Test files selection chose, and why they were chosen. */
  selectedTests: number;
  selectedByCoverage: number;
  selectedByPolicy: number;
  /** True when covsel declined to select and ran everything. */
  fullRun: boolean;
  fullRunReason?: string;
  selectionRatio: number;
  /** Test files whose outcome the change altered. */
  outcomesChanged: string[];
  /** The safety measurement: altered outcomes selection left out. Must be empty. */
  misses: string[];
  timings: {
    recordMs: number;
    affectedMs: number;
    selectedMs: number;
    fullMs: number;
  };
  wallClockRatio: number;
  /** Absent when a selected run never pays its recording back. */
  breakEvenRuns?: number;
}

export interface MeasureInit {
  project: BenchmarkProject;
  /** A prepared checkout: dependencies installed, map recorded at `base`. */
  repo: string;
  /** The commit the map was recorded on. */
  base: string;
  /** The commit to replay onto it. */
  head: string;
  /** Path to the covsel CLI entry point. */
  covselBin: string;
  /** What recording the map at `base` cost. */
  recordMs: number;
  /** Per-file outcomes at `base`, collected before moving off it. */
  baseOutcomes: Outcomes;
  /** How many times to run each timed command; the median is reported. */
  repetitions?: number;
  onEvent?: (event: ReplayEvent) => void;
}

interface Timed {
  ms: number;
  stdout: string;
  stderr: string;
  status: number | null;
}

function run(command: string[], cwd: string): Timed {
  const [bin, ...rest] = command;
  if (bin === undefined) throw new Error('replay: empty command');
  const started = process.hrtime.bigint();
  const result = spawnSync(bin, rest, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.error) throw result.error;
  return {
    ms,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/** Run a command `repetitions` times and report the median wall-clock. */
function timeRepeatedly(command: string[], cwd: string, repetitions: number): number {
  const samples: number[] = [];
  for (let i = 0; i < repetitions; i++) samples.push(run(command, cwd).ms);
  return median(samples) ?? 0;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

function changedFilesBetween(base: string, head: string, cwd: string): string[] {
  return git(['diff', '--name-only', `${base}..${head}`], cwd)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Test files whose map entry credits no source, which policy always runs. */
function entriesCreditingNoSource(repo: string, config: CovselConfig): string[] {
  const stored = new LocalStore({ cwd: repo, dir: config.store.dir }).inspect();
  if (stored.state !== 'usable') return [];
  const files = new Set<string>();
  for (const entry of stored.map.entries) {
    if (entry.files.length === 0) files.add(entry.test.file);
  }
  return [...files].sort();
}

/**
 * Measure one change against a map recorded on its base.
 *
 * The map is recorded on `base` and then carried across to `head` untouched,
 * because that is what CI does: a map published from the default branch is
 * restored onto a branch built from it. Selection measures from the commit the
 * map records, so no diff window is passed here -- computing one by hand would
 * be a second opinion about the window, and the wrong one if it disagreed.
 */
export function measure(init: MeasureInit): ReplayResult {
  const { project, repo, covselBin } = init;
  const repetitions = init.repetitions ?? 1;
  const emit = (step: ReplayEvent['step'], detail?: string): void =>
    init.onEvent?.(detail === undefined ? { step } : { step, detail });

  emit('checkout', init.head);
  git(['checkout', '--quiet', init.head], repo);

  const config = resolveConfig(project.covsel);
  const discovered = discoverTestFiles(repo, config);
  const changed = changedFilesBetween(init.base, init.head, repo);

  emit('affected');
  const affected = run([process.execPath, covselBin, 'affected'], repo);
  // A failed `affected` prints no files, which is indistinguishable from a
  // correct empty selection once the exit status is discarded -- and it is the
  // one confusion that flatters covsel, since a run that selected nothing and
  // was never asked to run anything also misses nothing. Refuse to score it.
  if (affected.status !== 0) {
    throw new Error(
      `covsel affected failed (exit ${affected.status ?? 'signal'}) at ${init.head}:\n` +
        affected.stderr.trim(),
    );
  }
  const selected = affected.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  // Whether covsel will fall open is read from `status`, which reports the
  // decision and its reason as a documented surface, rather than inferred from
  // an empty file list. The two are not the same: a full run legitimately prints
  // no files, and scoring that as "nothing selected" would report a fall-open as
  // a perfect result -- and report no misses either, since no outcome can fall
  // outside a set that is in fact everything.
  const decision = readDecision(covselBin, repo);
  const effectiveSelection = decision.fullRun ? discovered : selected;

  emit('selected-run');
  const selectedMs = timeRepeatedly(
    [process.execPath, covselBin, 'run', '--', ...project.runner],
    repo,
    repetitions,
  );

  emit('full-run');
  const fullMs = timeRepeatedly([...project.runner, ...discovered], repo, repetitions);

  emit('head-outcomes');
  const headOutcomes = collectOutcomes({
    command: project.runner,
    cwd: repo,
    files: discovered,
  });

  const changedTestFiles = changed.filter((file) => matchesAny(file, config.testGlobs));
  const split = splitSelection({
    selected: effectiveSelection,
    changedTestFiles,
    alwaysRun: discovered.filter((file) => matchesAny(file, config.alwaysRun)),
    creditingNoSource: entriesCreditingNoSource(repo, config),
  });

  const timings = {
    recordMs: init.recordMs,
    affectedMs: affected.ms,
    selectedMs,
    fullMs,
  };
  const payback = breakEvenRuns(timings);

  emit('done');
  return {
    project: project.name,
    repo: project.repo,
    base: init.base,
    head: init.head,
    changedFiles: changed.length,
    stratum: stratumOf(changed.length),
    totalTests: discovered.length,
    selectedTests: effectiveSelection.length,
    selectedByCoverage: split.coverage.length,
    selectedByPolicy: split.policy.length,
    fullRun: decision.fullRun,
    ...(decision.reason === undefined ? {} : { fullRunReason: decision.reason }),
    selectionRatio: selectionRatio(effectiveSelection.length, discovered.length),
    outcomesChanged: changedOutcomes(init.baseOutcomes, headOutcomes),
    misses: outcomeMisses(init.baseOutcomes, headOutcomes, effectiveSelection),
    timings,
    wallClockRatio: wallClockRatio(timings),
    ...(payback === undefined ? {} : { breakEvenRuns: payback }),
  };
}

interface Decision {
  fullRun: boolean;
  reason?: string;
}

/** Ask covsel what it will do next, rather than inferring it from a file list. */
export function readDecision(covselBin: string, repo: string): Decision {
  const status = run([process.execPath, covselBin, 'status'], repo);
  if (status.status !== 0) {
    throw new Error(
      `covsel status failed (exit ${status.status ?? 'signal'}):\n${status.stderr.trim()}`,
    );
  }
  const next = /^next:\s+(.*)$/m.exec(status.stdout)?.[1]?.trim();
  if (next === undefined || !next.startsWith('full run')) return { fullRun: false };
  const reason = /^full run \((.*)\)$/.exec(next)?.[1];
  return reason === undefined ? { fullRun: true } : { fullRun: true, reason };
}
