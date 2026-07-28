import { spawnSync } from 'node:child_process';

import type { Change } from './interfaces.js';

/** Thrown when git cannot be run or the directory is not a work tree. */
export class GitUnavailableError extends Error {}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error)
    throw new GitUnavailableError(`git ${args.join(' ')}: ${res.error.message}`);
  return { ok: res.status === 0, stdout: res.stdout ?? '' };
}

/** Current HEAD commit, or `undefined` when unavailable (e.g. no commits yet). */
export function gitHeadCommit(cwd: string): string | undefined {
  try {
    const res = git(cwd, ['rev-parse', 'HEAD']);
    return res.ok ? res.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** True when this checkout actually has the given commit (or ref). */
export function commitExists(cwd: string, ref: string): boolean {
  return resolvable(cwd, ref);
}

/**
 * True when `cwd` is inside a git work tree. The command also succeeds in a bare
 * repository and inside `.git/`, printing `false`, so the output is what counts.
 */
export function isGitWorkTree(cwd: string): boolean {
  try {
    const res = git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return res.ok && res.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** A ref that exists and can be resolved, or `undefined`. */
function resolvable(cwd: string, ref: string): boolean {
  try {
    return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;
  } catch {
    return false;
  }
}

/** The default-branch base to diff against: `origin/main`, then `main`. */
function defaultBase(cwd: string): string | undefined {
  if (resolvable(cwd, 'origin/main')) return 'origin/main';
  if (resolvable(cwd, 'main')) return 'main';
  return undefined;
}

function mergeBase(cwd: string, a: string, b: string): string | undefined {
  try {
    const res = git(cwd, ['merge-base', a, b]);
    return res.ok ? res.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the work tree differs from HEAD in any way — staged, unstaged, or
 * untracked. A map recorded from such a tree describes a state no commit names,
 * yet it is stamped with HEAD, so a later checkout of exactly HEAD would trust a
 * map that never described it. Callers that record on their own schedule check
 * this first.
 *
 * A git that cannot answer reads as dirty: declining to record leaves the
 * previous map in place, which over-selects, while recording anyway would write
 * one that cannot be vouched for.
 */
export function isDirtyWorkTree(cwd: string): boolean {
  try {
    const res = git(cwd, ['status', '--porcelain']);
    return !res.ok || res.stdout.trim() !== '';
  } catch {
    return true;
  }
}

/**
 * Drop the paths git ignores, keeping the rest in order. A file git ignores can
 * never show up in a diff, so a change to one cannot affect selection — which is
 * what keeps a runner's own output from re-triggering a watch loop.
 *
 * Tracked files are never dropped: `check-ignore` consults the index, and a
 * tracked file is not subject to ignore rules. When git cannot answer at all,
 * every path is kept, so the caller decides on more input rather than less.
 */
export function filterUnignored(cwd: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const res = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
    cwd,
    encoding: 'utf8',
    input: `${paths.join('\0')}\0`,
    maxBuffer: 64 * 1024 * 1024,
  });
  // 0: some paths are ignored. 1: none are. Anything else (128, a signal, git
  // missing) means git did not answer, so nothing may be dropped.
  if (res.error || (res.status !== 0 && res.status !== 1)) return paths;
  const ignored = new Set((res.stdout ?? '').split('\0').filter((p) => p !== ''));
  return paths.filter((p) => !ignored.has(p));
}

function kindFromStatusLetter(letter: string): Change['kind'] {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

/** Merge a change into the accumulator, keeping the most inclusive kind. */
function record(acc: Map<string, Change>, file: string, kind: Change['kind']): void {
  const prev = acc.get(file);
  if (!prev) {
    acc.set(file, { file, kind });
    return;
  }
  const order: Change['kind'][] = ['added', 'modified', 'renamed', 'deleted'];
  const strongest = order[Math.min(order.indexOf(prev.kind), order.indexOf(kind))];
  acc.set(file, { file, kind: strongest ?? kind });
}

/** Parse `git diff --name-status` output into changes. */
function parseNameStatus(acc: Map<string, Change>, out: string): void {
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    const letter = status[0] ?? 'M';
    if ((letter === 'R' || letter === 'C') && parts.length >= 3) {
      if (parts[1]) record(acc, parts[1], 'deleted');
      if (parts[2]) record(acc, parts[2], 'added');
      continue;
    }
    const file = parts[1];
    if (file) record(acc, file, kindFromStatusLetter(letter));
  }
}

/** Parse `git status --porcelain` output (staged + unstaged + untracked). */
function parsePorcelain(acc: Map<string, Change>, out: string): void {
  for (const line of out.split('\n')) {
    if (line.length < 3) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    if (xy === '??') {
      record(acc, rest, 'added');
      continue;
    }
    if (rest.includes(' -> ')) {
      const [oldPath, newPath] = rest.split(' -> ');
      if (oldPath) record(acc, oldPath, 'deleted');
      if (newPath) record(acc, newPath, 'added');
      continue;
    }
    const code = xy[0] !== ' ' ? xy[0] : xy[1];
    record(acc, rest, kindFromStatusLetter(code ?? 'M'));
  }
}

export interface DiffOptions {
  /**
   * Compare the base's tree to HEAD directly instead of going through their
   * merge-base. Use this when the base is a state the caller must account for in
   * full — a map's recorded commit — rather than a branch point. Going through
   * the merge-base would hide every file that differs between the base and HEAD's
   * ancestor, which is exactly the coverage the map was recorded against.
   */
  exact?: boolean;
}

/**
 * Produce the set of changed files: committed changes since `since` (by default
 * the merge-base of HEAD and the default branch), plus every working-tree change
 * (staged, unstaged, and untracked). Paths are repo-relative with forward
 * slashes.
 *
 * With `exact`, the committed half is `git diff <since> HEAD`, so together with
 * the working-tree half it covers every file whose content differs between the
 * base's tree and what is on disk now — in either direction.
 */
export function diffChanges(
  cwd: string,
  since?: string,
  options: DiffOptions = {},
): Change[] {
  if (!git(cwd, ['rev-parse', '--is-inside-work-tree']).ok) {
    throw new GitUnavailableError('not a git work tree');
  }
  const acc = new Map<string, Change>();

  const base = since ?? defaultBase(cwd);
  if (base !== undefined) {
    const from = options.exact ? base : (mergeBase(cwd, base, 'HEAD') ?? base);
    const committed = git(cwd, ['diff', '--name-status', from, 'HEAD']);
    if (committed.ok) parseNameStatus(acc, committed.stdout);
  }

  const working = git(cwd, ['status', '--porcelain']);
  if (working.ok) parsePorcelain(acc, working.stdout);

  return [...acc.values()];
}
