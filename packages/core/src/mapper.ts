import { fileURLToPath } from 'node:url';

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

/**
 * Maps raw V8 script coverage to repo-relative source files. A script counts as
 * covered when any of its function ranges executed at least once. Only files
 * that pass the source filter (under the repo, not vendored, not tests) are
 * kept, each fingerprinted by its content hash at record time.
 */
export class V8FileMapper implements Mapper {
  private readonly cwd: string;
  private readonly isSource: (rel: string) => boolean;

  constructor(init: V8FileMapperInit) {
    this.cwd = init.cwd;
    this.isSource = makeSourceFilter(init.config);
  }

  async toFiles(raw: RawCoverage): Promise<CoveredFile[]> {
    const covered = new Map<string, string>();
    for (const script of raw.scripts as ScriptCoverage[]) {
      if (!script.url.startsWith('file://')) continue;
      let abs: string;
      try {
        abs = fileURLToPath(stripUrlQuery(script.url));
      } catch {
        continue;
      }
      const rel = toRepoRelative(this.cwd, abs);
      if (rel === undefined || !this.isSource(rel) || covered.has(rel)) continue;
      const executed = script.functions.some((fn) => fn.ranges.some((r) => r.count > 0));
      if (!executed) continue;
      covered.set(rel, hashFileContents(abs));
    }
    return [...covered]
      .map(([file, fileHash]) => ({ file, fileHash }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  async toBlocks(): Promise<CoveredBlock[]> {
    throw new Error('block granularity is not implemented in this release');
  }
}
