import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Temp-repository helpers for tests that need a real git work tree — selection
 * reads a diff, so anything exercising it end to end needs one.
 */

/**
 * Run git in `cwd`, throwing on failure. The developer's own git configuration
 * is pinned out so a local `init.defaultBranch`, hooks, or signing settings
 * cannot change what these tests measure.
 */
export function git(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** Write a repo-relative file, creating its directories. */
export function write(cwd: string, rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/** Initialise a repository in `cwd` and commit everything already written. */
export function commitAll(cwd: string, message = 'fixture'): void {
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'covsel test']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', message]);
}
