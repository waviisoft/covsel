import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type ExecRegion, selectExecutedBlocks } from './blocks.js';
import type { CovselConfig } from './config.js';
import { makeSourceFilter } from './discover.js';
import type { Mapper, RawCoverage } from './interfaces.js';
import type { ScriptCoverage } from './observer.js';
import { hashFileContents, stripUrlQuery, toRepoRelative } from './paths.js';
import type { CoveredBlock, CoveredFile } from './schema.js';

export interface V8FileMapperInit {
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs'>;
}

const byFileThenHash = (
  a: { file: string; blockHash: string },
  b: { file: string; blockHash: string },
): number =>
  a.file < b.file
    ? -1
    : a.file > b.file
      ? 1
      : a.blockHash < b.blockHash
        ? -1
        : a.blockHash > b.blockHash
          ? 1
          : 0;

/**
 * Maps raw V8 script coverage to repo-relative source files and blocks. A script
 * counts as covered when any of its function ranges executed at least once. Only
 * files that pass the source filter (under the repo, not vendored, not tests)
 * are kept, each fingerprinted by its content hash at record time.
 */
export class V8FileMapper implements Mapper {
  private readonly cwd: string;
  private readonly isSource: (rel: string) => boolean;

  constructor(init: V8FileMapperInit) {
    this.cwd = init.cwd;
    this.isSource = makeSourceFilter(init.config);
  }

  /** Resolve a script URL to a repo-relative source path we should record. */
  private sourcePath(url: string): { rel: string; abs: string } | undefined {
    if (!url.startsWith('file://')) return undefined;
    let abs: string;
    try {
      abs = fileURLToPath(stripUrlQuery(url));
    } catch {
      return undefined;
    }
    const rel = toRepoRelative(this.cwd, abs);
    if (rel === undefined || !this.isSource(rel)) return undefined;
    return { rel, abs };
  }

  async toFiles(raw: RawCoverage): Promise<CoveredFile[]> {
    const covered = new Map<string, string>();
    for (const script of raw.scripts as ScriptCoverage[]) {
      const resolved = this.sourcePath(script.url);
      if (!resolved || covered.has(resolved.rel)) continue;
      const executed = script.functions.some((fn) => fn.ranges.some((r) => r.count > 0));
      if (!executed) continue;
      covered.set(resolved.rel, hashFileContents(resolved.abs));
    }
    return [...covered]
      .map(([file, fileHash]) => ({ file, fileHash }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  /**
   * Block-level coverage for direct-execution runners. V8 range offsets index
   * the source *as executed*, matched here against the on-disk file — sound only
   * when they are the same bytes (plain JS, or position-preserving type
   * stripping). Runners that transform sources before executing them (Vitest,
   * Jest, ts-node/tsx) must record blocks through their own adapter, which reads
   * the runner's source-mapped coverage instead.
   */
  async toBlocks(raw: RawCoverage): Promise<CoveredBlock[]> {
    const out: CoveredBlock[] = [];
    const seen = new Set<string>();
    for (const script of raw.scripts as ScriptCoverage[]) {
      const resolved = this.sourcePath(script.url);
      if (!resolved) continue;
      const executed = script.functions.some((fn) => fn.ranges.some((r) => r.count > 0));
      if (!executed) continue;
      let source: string;
      try {
        source = readFileSync(resolved.abs, 'utf8');
      } catch {
        continue;
      }
      const regions: ExecRegion[] = [];
      for (const fn of script.functions) {
        for (const r of fn.ranges) {
          regions.push({ start: r.startOffset, end: r.endOffset, count: r.count });
        }
      }
      for (const block of selectExecutedBlocks(source, resolved.rel, regions)) {
        const key = `${resolved.rel}\0${block.hash}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ file: resolved.rel, blockHash: block.hash });
      }
    }
    return out.sort(byFileThenHash);
  }
}
