import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Observer, RawCoverage } from './interfaces.js';
import type { TestId } from './schema.js';

/** Minimal shape of a V8 ScriptCoverage entry from a NODE_V8_COVERAGE dump. */
export interface ScriptCoverage {
  url: string;
  functions: {
    functionName?: string;
    ranges: { startOffset: number; endOffset: number; count: number }[];
  }[];
}

export interface ProcessObserverInit {
  /** Base command to run, e.g. `['node', '--test']` or `['vitest', 'run']`. */
  command: string[];
  /** Working directory for the child process (the repo root). */
  cwd: string;
  /** Extra environment for the child, merged over the parent environment. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Whole-file Observer: run one test *file* in its own process with
 * `NODE_V8_COVERAGE` pointed at a temp dir, then return the raw V8 script
 * coverage the process produced. This is the mechanism the coverage-observation
 * integration test guards, promoted to a reusable API. It attributes coverage
 * per test file with zero runner integration, and works for any runner that
 * executes source directly (its script URLs are real `file://` paths). Runners
 * that evaluate transformed sources through their own module loader need a
 * per-runner observation path instead.
 */
export class ProcessObserver implements Observer {
  private readonly init: ProcessObserverInit;
  private readonly dirs = new Map<string, string>();

  constructor(init: ProcessObserverInit) {
    this.init = init;
  }

  async startTest(id: TestId): Promise<void> {
    this.dirs.set(id.file, mkdtempSync(join(tmpdir(), 'covsel-cov-')));
  }

  async endTest(id: TestId): Promise<RawCoverage> {
    const covDir = this.dirs.get(id.file);
    if (covDir === undefined) {
      throw new Error(`endTest called before startTest for ${id.file}`);
    }
    const [bin, ...rest] = this.init.command;
    if (bin === undefined) throw new Error('empty command');
    try {
      const res = spawnSync(bin, [...rest, id.file], {
        cwd: this.init.cwd,
        env: { ...process.env, ...this.init.env, NODE_V8_COVERAGE: covDir },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (res.error) throw res.error;
      if (res.status !== 0) {
        const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
        throw new Error(
          `command exited with ${res.status ?? 'signal'} while recording ${id.file}\n${output}`,
        );
      }
      const scripts: ScriptCoverage[] = [];
      for (const dump of readdirSync(covDir).filter((f) => f.endsWith('.json'))) {
        const parsed = JSON.parse(readFileSync(join(covDir, dump), 'utf8')) as {
          result?: ScriptCoverage[];
        };
        if (parsed.result) scripts.push(...parsed.result);
      }
      return { scripts };
    } finally {
      rmSync(covDir, { recursive: true, force: true });
      this.dirs.delete(id.file);
    }
  }
}
