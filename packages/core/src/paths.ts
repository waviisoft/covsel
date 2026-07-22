import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * Directories that are never sources, tests, or map targets. Excluded from
 * discovery and from coverage attribution at any depth in the tree.
 */
export const DEFAULT_EXCLUDES = [
  'node_modules',
  'dist',
  'coverage',
  '.covsel',
  '.git',
] as const;

const EXCLUDE_SET = new Set<string>(DEFAULT_EXCLUDES);

/** True when any segment of a repo-relative path is an excluded directory. */
export function isExcludedRel(rel: string): boolean {
  return rel.split('/').some((seg) => EXCLUDE_SET.has(seg));
}

/**
 * Convert an absolute path to a repo-relative, forward-slashed path, or
 * `undefined` when the path is outside `cwd`.
 */
export function toRepoRelative(cwd: string, abs: string): string | undefined {
  const rel = relative(cwd, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** Strip a `?query` / `#fragment` suffix from a script URL. */
export function stripUrlQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Content fingerprint of a file, prefixed with the algorithm. */
export function hashFileContents(absPath: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(absPath)).digest('hex')}`;
}

/** Content fingerprint of an in-memory string, prefixed with the algorithm. */
export function hashString(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Recursively list every file under `cwd` as repo-relative, forward-slashed
 * paths, skipping the excluded directories. Unreadable directories are skipped
 * rather than fatal.
 */
export function walkFiles(
  cwd: string,
  excludes: readonly string[] = DEFAULT_EXCLUDES,
): string[] {
  const skip = new Set<string>(excludes);
  const out: string[] = [];
  const visit = (relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(join(cwd, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        visit(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  visit('');
  return out;
}
