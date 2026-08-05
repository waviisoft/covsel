import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BenchmarkProject } from './project.js';
import { readDecision } from './replay.js';

export interface PrepareInit {
  project: BenchmarkProject;
  /** Directory clones live in. */
  work: string;
  /** Directory holding the workspace packages to link into the clone. */
  packagesRoot: string;
  log?: (message: string) => void;
}

function must(command: string[], cwd: string, what: string): void {
  const [bin, ...rest] = command;
  if (bin === undefined) throw new Error(`${what}: empty command`);
  const result = spawnSync(bin, rest, { cwd, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw new Error(`${what} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${what} failed (exit ${result.status ?? 'signal'})`);
  }
}

/**
 * Write the project's covsel configuration into the clone, and hide it from git.
 *
 * The hiding is not tidiness. Recording samples the work tree first and refuses
 * to anchor a map to a commit when anything is uncommitted -- untracked files
 * included -- because a map recorded from an edited tree describes a state no
 * commit names. An unanchored map falls open, so leaving this file merely
 * written would make every replay a full run: selection would never narrow,
 * every miss check would pass because covsel ran everything, and the harness
 * would report that as a clean result. Excluding it keeps the tree exactly as
 * the pinned commit left it while covsel still reads the file.
 */
export function writeCovselConfig(repo: string, project: BenchmarkProject): void {
  writeFileSync(
    join(repo, 'covsel.json'),
    `${JSON.stringify(project.covsel, null, 2)}\n`,
  );
  // info/exclude rather than .gitignore: it is per-clone and not itself tracked,
  // so hiding the config does not dirty the tree in the act of cleaning it.
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '\ncovsel.json\n.covsel/\n');
}

/**
 * Link the workspace build into the clone rather than installing from a
 * registry, because these packages are not published yet. The clone resolves
 * `@covsel/*` the way a real project would; only where the files came from
 * differs.
 */
export function linkCovselInto(
  repo: string,
  project: BenchmarkProject,
  packagesRoot: string,
): void {
  const scope = join(repo, 'node_modules', '@covsel');
  mkdirSync(scope, { recursive: true });
  for (const name of ['core', project.adapter.replace(/^@covsel\//, '')]) {
    const target = join(packagesRoot, name);
    if (!existsSync(target)) throw new Error(`no workspace package for ${name}`);
    const link = join(scope, name);
    const result = spawnSync('ln', ['-sfn', target, link], { encoding: 'utf8' });
    // A link that silently failed surfaces much later as a confusing recording
    // failure, or worse as a runner that exits instantly and looks fast.
    if (result.status !== 0 || !existsSync(link)) {
      throw new Error(`could not link ${name} into ${scope}`);
    }
  }
}

/** Clone (or reuse), check out the pinned base, install, and wire covsel in. */
export function prepareClone(init: PrepareInit): string {
  const { project, work } = init;
  const log = init.log ?? ((): void => {});
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
  linkCovselInto(repo, project, init.packagesRoot);
  writeCovselConfig(repo, project);
  return repo;
}

export interface RecordInit {
  project: BenchmarkProject;
  repo: string;
  covselBin: string;
  timeoutMs: number;
  log?: (message: string) => void;
}

/**
 * Record the map at the base, and refuse to continue unless the result can
 * actually select.
 *
 * The guard is the point. A map recorded on a clean tree at the base, with no
 * changes yet made, must leave covsel intending to select -- that is what having
 * a usable map means. If covsel says it will fall open instead, something about
 * the setup is wrong (an unanchored map, a map with no entries, a sentinel the
 * project moves at install time), and every replay built on it would report a
 * full run as a flawless, zero-miss result. Failing here turns the one failure
 * that flatters covsel into a loud one.
 */
export function recordMap(init: RecordInit): number {
  const { project, repo, covselBin } = init;
  const log = init.log ?? ((): void => {});
  log('recording the map');
  const started = process.hrtime.bigint();
  const result = spawnSync(
    process.execPath,
    [covselBin, 'record', '--adapter', project.adapterName, '--', ...project.runner],
    { cwd: repo, encoding: 'utf8', stdio: 'inherit', timeout: init.timeoutMs },
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

  const decision = readDecision(covselBin, repo);
  if (decision.fullRun) {
    throw new Error(
      `the map just recorded cannot select: covsel would run everything ` +
        `(${decision.reason ?? 'no reason given'}). Every replay from it would ` +
        `report a full run as a clean, zero-miss result, so this is refused ` +
        `rather than measured.`,
    );
  }

  log(`recorded in ${(ms / 1000).toFixed(1)}s`);
  return ms;
}
