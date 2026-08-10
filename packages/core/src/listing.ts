/**
 * The parts of "ask the runner what it collects" that are the same whichever
 * runner is being asked.
 *
 * Five adapters implement {@link Adapter.listTests} by spawning their runner
 * with a listing flag and reading paths out of the result. What differs between
 * them is the flag and the shape of the output; what does not is the handling of
 * everything that can go wrong -- and that handling is load-bearing. A listing
 * that half-works is worse than one that fails, because a partial set compares
 * against covsel's full discovery as drift and sends someone editing `testGlobs`
 * over a question the runner was never asked. Getting that identically right in
 * five places by hand is how the five stop agreeing.
 *
 * Everything here throws rather than returning a reason. The capability's
 * contract is `Promise<string[]>`, and a consumer reports a throw as a check it
 * could not make -- which is the safe reading, and the same one for a runner too
 * old for the flag, a config that will not load, and a command that was never
 * this runner at all.
 */
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

import { toRepoRelative } from './paths.js';

/**
 * How long to wait for a listing before giving up.
 *
 * Listing is a question, not a run, so it has no business taking minutes.
 * Without a bound, a command that never exits -- watch mode, a wrapper script
 * that waits -- hangs covsel with no output at all, which is the one failure a
 * diagnostic must not have.
 */
export const LIST_TIMEOUT_MS = 120_000;

/** Run a runner's listing command and hand back its stdout. */
export function listingOutput(init: {
  /** The runner's name, for the message a failure carries. */
  runner: string;
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const [bin, ...args] = init.argv;
  if (bin === undefined) throw new Error('empty command');
  const shown = init.argv.join(' ');
  const cannot = `could not ask ${init.runner} what it collects`;
  const res = spawnSync(bin, args, {
    cwd: init.cwd,
    ...(init.env ? { env: { ...process.env, ...init.env } } : {}),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: LIST_TIMEOUT_MS,
  });
  if (res.error) {
    const timedOut = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    throw new Error(
      timedOut
        ? `${cannot}: \`${shown}\` did not finish within ${LIST_TIMEOUT_MS / 1000}s. ` +
            'A listing should be quick, so this is usually a command that never ' +
            'exits -- watch mode, or a script that waits.'
        : `${cannot}: \`${shown}\` -- ${res.error.message}`,
    );
  }
  if (res.status !== 0) {
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    throw new Error(`${cannot}: \`${shown}\` failed\n${output}`);
  }
  return res.stdout ?? '';
}

/** Parse a listing's stdout as JSON, or say the command was not what it claimed. */
export function listingJson(runner: string, stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    // A command that was never this runner may still exit 0 having printed
    // something. Anything unparseable is treated as no answer, because a
    // half-understood one compares as drift.
    throw new Error(
      `could not ask ${runner} what it collects: the command printed no JSON. ` +
        `Point \`covsel\` at ${runner} directly rather than at a script that ` +
        'wraps it, or leave the check out.',
    );
  }
}

/** Say the output parsed but was not a file listing. */
export function notAListing(runner: string): Error {
  return new Error(
    `could not ask ${runner} what it collects: the command printed JSON that is ` +
      `not a test file listing. Point \`covsel\` at ${runner} directly rather ` +
      'than at a script that wraps it, or leave the check out.',
  );
}

/**
 * Refuse a command that narrows the run, rather than answering it.
 *
 * `jest test/unit` lists the files under that path, exits 0, and produces
 * perfectly shaped output -- which compares against covsel's full discovery as
 * "covsel discovers 35 files the runner does not collect", advice to put 35 real
 * test files beyond covsel's reach. A narrowed run is a different question from
 * the one being asked, so it is not answered.
 *
 * Syntactic, so it catches the shape people actually type and not every one: a
 * bare word after a value-taking flag is that flag's value, and covsel has no
 * table of which flags take values for which runner. This is one of two guards
 * -- the report itself says a narrowing command explains that direction --
 * because no syntax check can be sure.
 *
 * `after` is where the runner's own name and subcommand stop and its arguments
 * begin, so `npx playwright test` is not read as three filters.
 */
export function refuseNarrowing(
  runner: string,
  args: readonly string[],
  after: number,
): void {
  const filter = args.slice(after + 1).find(isPositional);
  if (filter === undefined) return;
  throw new Error(
    `could not ask ${runner} what it collects: \`${filter}\` narrows the run to ` +
      'part of the suite, and covsel compares the answer against your whole test ' +
      'discovery. Ask with the unfiltered command.',
  );
}

/** A bare argument rather than a flag or a flag's value. */
function isPositional(arg: string, index: number, args: readonly string[]): boolean {
  if (arg.startsWith('-')) return false;
  // `--reporter junit` puts a bare word after a flag that takes a value. Only
  // the space-separated form is ambiguous; `--reporter=junit` is one token.
  const previous = args[index - 1];
  return previous === undefined || !previous.startsWith('-') || previous.includes('=');
}

/**
 * Where a runner's own invocation ends in a command, so what follows can be read
 * as arguments. `-1` when the runner's name is nowhere in it, which leaves the
 * narrowing guard silent rather than reading `pnpm test` as a filter.
 */
export function runnerTokenIndex(args: readonly string[], name: string): number {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i];
    if (arg !== undefined && !arg.startsWith('-') && arg.includes(name)) return i;
  }
  return -1;
}

/**
 * The paths a listing named, as the comparison needs them: repo-relative POSIX,
 * deduplicated, sorted.
 *
 * Deduplicated because a runner may name a file once per project or per shard,
 * and reading that as a disagreement would make the guard fire on every run.
 * Dropped when outside the repository, since a file covsel could never discover
 * either is not drift any `testGlobs` edit could fix.
 *
 * Absolutised against `cwd` first, and not against the process's own directory:
 * runners disagree about which they answer in -- Jest and Vitest give absolute
 * paths, cucumber gives them relative to where it ran -- and `toRepoRelative`
 * would resolve a relative one against wherever covsel happens to be. Those are
 * the same directory in every ordinary invocation and different in the one that
 * matters, a listing asked for a project elsewhere, where it would silently
 * report the entire suite as drift.
 */
export function listedPaths(cwd: string, paths: readonly string[]): string[] {
  const rel = paths.map((p) => toRepoRelative(cwd, isAbsolute(p) ? p : resolve(cwd, p)));
  return [...new Set(rel.filter((r): r is string => r !== undefined))].sort();
}
