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
  unscorable,
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
  /**
   * Test files already failing at the base. A verdict per file cannot tell a
   * still-failing file from an unaffected one, so these are outside what the
   * miss oracle can score, and a zero miss count means less when this is high.
   */
  unscorable: string[];
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

interface TimedRuns {
  ms: number;
  /** The last status observed; `null` when the command died on a signal. */
  status: number | null;
}

/**
 * Run a command `repetitions` times, reporting the median wall-clock and how it
 * finished.
 *
 * The status is carried out rather than dropped because these two durations are
 * the published numbers. A runner that exits in 200ms because it could not start
 * produces a spectacular speedup, and a duration alone cannot be told apart from
 * a genuinely fast suite.
 */
function timeRepeatedly(command: string[], cwd: string, repetitions: number): TimedRuns {
  const samples: number[] = [];
  let status: number | null = 0;
  for (let i = 0; i < repetitions; i++) {
    const result = run(command, cwd);
    samples.push(result.ms);
    status = result.status;
  }
  return { ms: median(samples) ?? 0, status };
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
  // Discovering nothing is not a suite that selection narrowed perfectly: with
  // no test files there are no outcomes, so nothing can change, so nothing can
  // be missed. It would score as 0/0 selected with a clean oracle -- the most
  // flattering result the harness can produce, from the least measurement.
  if (discovered.length === 0) {
    throw new Error(
      `no test files matched ${config.testGlobs.join(', ')} at ${init.head} -- ` +
        `there is nothing to measure, and scoring it would report zero misses ` +
        `for a suite that never ran`,
    );
  }
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
  const selectedRun = timeRepeatedly(
    [process.execPath, covselBin, 'run', '--', ...project.runner],
    repo,
    repetitions,
  );

  emit('full-run');
  const fullRunTimed = timeRepeatedly(
    [...project.runner, ...discovered],
    repo,
    repetitions,
  );

  // A non-zero status is expected here: a change that breaks a test makes the
  // runner exit non-zero, and that is a result rather than a fault. These two
  // combinations are not. A signal means the process was killed rather than
  // finishing, and a selected run that failed while the full run passed cannot
  // be a test failure -- the selected files are a subset of the full ones, so
  // the same tests passed a moment later. Both would otherwise publish a
  // duration for work that did not happen.
  for (const [what, timed] of [
    ['selected run', selectedRun],
    ['full run', fullRunTimed],
  ] as const) {
    if (timed.status === null) {
      throw new Error(`the ${what} was killed by a signal, so its timing is not real`);
    }
  }
  if (selectedRun.status !== 0 && fullRunTimed.status === 0) {
    throw new Error(
      `the selected run failed (exit ${selectedRun.status}) while the full run ` +
        `passed. The selected files are a subset of the full ones, so this is a ` +
        `harness or runner fault rather than a test failure, and its timing ` +
        `would publish a saving for work that did not happen.`,
    );
  }

  emit('head-outcomes');
  const headOutcomes = collectOutcomes({
    command: project.runner,
    cwd: repo,
    files: discovered,
  });

  const changedTestFiles = changed.filter((file) => matchesAny(file, config.testGlobs));
  // A fall-open is policy start to finish: covsel declined to consult coverage
  // at all. Splitting it as though the suite had been chosen file by file would
  // credit nearly every test to coverage-driven selection, which is the exact
  // misreading the split exists to prevent.
  const split = decision.fullRun
    ? { coverage: [], policy: [...discovered] }
    : splitSelection({
        selected: effectiveSelection,
        changedTestFiles,
        alwaysRun: discovered.filter((file) => matchesAny(file, config.alwaysRun)),
        creditingNoSource: entriesCreditingNoSource(repo, config),
      });

  const timings = {
    recordMs: init.recordMs,
    affectedMs: affected.ms,
    selectedMs: selectedRun.ms,
    fullMs: fullRunTimed.ms,
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
    unscorable: unscorable(init.baseOutcomes, headOutcomes),
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
