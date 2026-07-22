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

/**
 * Produce the set of changed files: committed changes since the merge-base of
 * HEAD and the default branch (or an explicit `since` ref), plus every
 * working-tree change (staged, unstaged, and untracked). Paths are
 * repo-relative with forward slashes.
 */
export function diffChanges(cwd: string, since?: string): Change[] {
  if (!git(cwd, ['rev-parse', '--is-inside-work-tree']).ok) {
    throw new GitUnavailableError('not a git work tree');
  }
  const acc = new Map<string, Change>();

  const base = since ?? defaultBase(cwd);
  if (base !== undefined) {
    const mb = mergeBase(cwd, base, 'HEAD') ?? base;
    const committed = git(cwd, ['diff', '--name-status', mb, 'HEAD']);
    if (committed.ok) parseNameStatus(acc, committed.stdout);
  }

  const working = git(cwd, ['status', '--porcelain']);
  if (working.ok) parsePorcelain(acc, working.stdout);

  return [...acc.values()];
}
