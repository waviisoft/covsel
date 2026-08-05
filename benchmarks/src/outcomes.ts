import { spawnSync } from 'node:child_process';

import type { Outcome, Outcomes } from './metrics.js';

export interface CollectOutcomesInit {
  /** The runner command; one test file is appended to it per invocation. */
  command: string[];
  cwd: string;
  files: readonly string[];
  /** Per-file ceiling, so one hanging test cannot stall a whole replay. */
  timeoutMs?: number;
  onFile?: (file: string, outcome: Outcome) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A per-test-file verdict for a whole suite, by running each file in its own
 * process and reading its exit status.
 *
 * Every runner reports results differently -- TAP, JSON, a bespoke reporter --
 * and the oracle needs the same answer from all of them. An exit status is the
 * one signal every runner already gives, so this needs no per-runner parsing and
 * works for any runner covsel can wrap. It costs a process per file, which is
 * why it is used only to establish outcomes.
 *
 * These runs are deliberately **not** where timings come from. A process per
 * file measures process startup as much as it measures the suite, so wall-clock
 * numbers come from whole-suite runs instead. Keeping the two apart is what lets
 * the oracle be this blunt without distorting anything published.
 */
export function collectOutcomes(init: CollectOutcomesInit): Outcomes {
  const [bin, ...rest] = init.command;
  if (bin === undefined) throw new Error('collectOutcomes: empty command');

  const outcomes = new Map<string, Outcome>();
  for (const file of init.files) {
    const result = spawnSync(bin, [...rest, file], {
      cwd: init.cwd,
      encoding: 'utf8',
      timeout: init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    // A timeout, a signal, or a runner that could not start are all "this file
    // did not pass". Reading them as anything else would let a broken run look
    // like a green one, and the oracle built on top would then under-report the
    // tests a change altered.
    const outcome: Outcome = result.status === 0 ? 'passed' : 'failed';
    outcomes.set(file, outcome);
    init.onFile?.(file, outcome);
  }
  return outcomes;
}
