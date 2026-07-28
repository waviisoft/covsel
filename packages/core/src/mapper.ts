import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type ExecRegion, selectExecutedBlocks } from './blocks.js';
import type { CovselConfig } from './config.js';
import { makeSourceFilter } from './discover.js';
import type { Mapper, RawCoverage } from './interfaces.js';
import { makeStrictMatcher } from './match.js';
import type { ScriptCoverage } from './observer.js';
import {
  hashFileContents,
  isExcludedRel,
  stripUrlQuery,
  toRepoRelative,
} from './paths.js';
import type { CoveredBlock, CoveredFile } from './schema.js';
import { SourceMapResolver } from './source-map.js';

export interface V8FileMapperInit {
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs'> &
    Partial<Pick<CovselConfig, 'sourceMaps'>>;
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
 * Raised when a script executed and nothing could be said about what source it
 * came from. Recording one test file is all-or-nothing for the same reason the
 * whole map is: an entry that credits nothing is read as a test that covers
 * nothing, and there is no later stage that can tell the two apart.
 */
export class UnmappableScriptError extends Error {
  readonly scripts: readonly string[];

  constructor(scripts: readonly string[]) {
    super(
      `executed ${scripts.length === 1 ? 'script' : 'scripts'} could not be mapped ` +
        `back to any source in this repository: ${scripts.join(', ')}. ` +
        'Build with source maps enabled, point `sourceMaps.buildDirs` at the ' +
        'built assets, or accept the gap with `sourceMaps.allowUnmappable`.',
    );
    this.name = 'UnmappableScriptError';
    this.scripts = scripts;
  }
}

/** What one executed script contributed, once covsel worked out what it was. */
interface Attribution {
  /** Repo-relative sources to record for it. */
  sources: string[];
  /** Set when the script could not be resolved to any source at all. */
  unmappable?: string;
  /** Set when it could not be, and the project has accepted that. */
  allowed?: string;
}

/**
 * Maps raw V8 script coverage to repo-relative source files and blocks.
 *
 * A script counts as covered when any of its function ranges executed at least
 * once. Where that script came from is the question this answers: a file the
 * repository holds is its own source; a bundle is only meaningful through its
 * source map; and a script that executed but resolves to neither is a hole in
 * the recording, raised as `UnmappableScriptError` rather than passed off as a
 * test that covered nothing.
 */
export class V8FileMapper implements Mapper {
  private readonly cwd: string;
  private readonly isSource: (rel: string) => boolean;
  private readonly isAllowedUnmappable: (label: string) => boolean;
  private readonly resolver: SourceMapResolver;
  /** Scripts the last mapping let through unmapped, for the caller to report. */
  private lastAllowed: string[] = [];

  constructor(init: V8FileMapperInit) {
    this.cwd = init.cwd;
    this.isSource = makeSourceFilter(init.config);
    const sourceMaps = init.config.sourceMaps;
    // Read as written, like the observed scope and for the same reason: every
    // path this matches is a recording gap the project accepts, so a glob that
    // quietly matched more than it says would hide gaps nobody agreed to.
    this.isAllowedUnmappable = makeStrictMatcher(sourceMaps?.allowUnmappable ?? []);
    this.resolver = new SourceMapResolver({
      cwd: init.cwd,
      ...(sourceMaps?.buildDirs ? { buildDirs: sourceMaps.buildDirs } : {}),
      ...(sourceMaps?.http !== undefined ? { http: sourceMaps.http } : {}),
    });
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

  /** How a script is named in configuration and in failures: its path, or its URL. */
  private label(url: string): string {
    if (!url.startsWith('file://')) return stripUrlQuery(url);
    try {
      const rel = toRepoRelative(this.cwd, fileURLToPath(stripUrlQuery(url)));
      return rel ?? stripUrlQuery(url);
    } catch {
      return stripUrlQuery(url);
    }
  }

  /**
   * What one executed script contributes, and whether covsel could account for
   * it at all.
   *
   * A script is accounted for when covsel knows what code it is, which is not
   * the same as recording it:
   *
   * - A file in the repository outside the build directories is its own source.
   *   Recorded when it passes the source filter, and deliberately skipped when
   *   it does not — a test file, or a path the project put outside `sourceGlobs`.
   *   If it also carries a source map, whatever that names is recorded too:
   *   crediting both the emitted file and the sources behind it over-selects,
   *   which is the safe direction.
   * - Vendored code under `node_modules` is outside what a recording maps by
   *   design; a dependency change is caught by the lockfile sentinel instead.
   * - A file outside the repository, and anything the runtime itself loaded
   *   (`node:` builtins, `eval`) is not this project's code.
   *
   * What is left is code built from this repository and served back to the
   * runner — out of a `dist/` directory, or over HTTP from a dev server. It
   * means nothing without its source map, so failing to resolve one is fatal.
   */
  private async attribute(url: string): Promise<Attribution> {
    const label = this.label(url);
    const none = (): Attribution =>
      this.isAllowedUnmappable(label)
        ? { sources: [], allowed: label }
        : { sources: [], unmappable: label };

    if (url.startsWith('file://')) {
      let abs: string;
      try {
        abs = fileURLToPath(stripUrlQuery(url));
      } catch {
        return { sources: [] };
      }
      const rel = toRepoRelative(this.cwd, abs);
      if (rel === undefined) return { sources: [] }; // someone else's code
      if (rel.split('/').includes('node_modules')) return { sources: [] }; // vendored
      if (!isExcludedRel(rel)) {
        const own = this.isSource(rel) ? [rel] : [];
        const mapped = await this.resolver.resolve({ url });
        const sources =
          mapped.kind === 'mapped'
            ? [...own, ...mapped.sources.filter(this.isSource)]
            : own;
        return { sources };
      }
      // Build output: derived from sources this repository does hold, and the
      // only way back to them is the map.
    } else if (!/^https?:\/\//.test(url)) {
      return { sources: [] }; // the runtime's own scripts, not the project's
    }

    if (this.isAllowedUnmappable(label)) return { sources: [], allowed: label };
    const mapped = await this.resolver.resolve({ url });
    if (mapped.kind === 'unmapped' || mapped.sources.length === 0) return none();
    return { sources: mapped.sources.filter(this.isSource) };
  }

  /**
   * The scripts the most recent `toFiles` accepted without mapping them, because
   * the project's configuration says to. Read after mapping so a recording can
   * report the gaps it is carrying.
   */
  allowedUnmappable(): string[] {
    return [...this.lastAllowed];
  }

  async toFiles(raw: RawCoverage): Promise<CoveredFile[]> {
    const covered = new Map<string, string>();
    const unmappable: string[] = [];
    const allowed = new Set<string>();
    for (const script of raw.scripts as ScriptCoverage[]) {
      const executed = script.functions.some((fn) => fn.ranges.some((r) => r.count > 0));
      if (!executed) continue;
      const attribution = await this.attribute(script.url);
      if (attribution.unmappable !== undefined) {
        if (!unmappable.includes(attribution.unmappable)) {
          unmappable.push(attribution.unmappable);
        }
        continue;
      }
      if (attribution.allowed !== undefined) allowed.add(attribution.allowed);
      for (const rel of attribution.sources) {
        if (covered.has(rel)) continue;
        // An unreadable source is left to throw, as it always has been: a
        // recording that cannot fingerprint what a test covered has to fail,
        // not quietly drop the file from the entry.
        covered.set(rel, hashFileContents(`${this.cwd}/${rel}`));
      }
    }
    this.lastAllowed = [...allowed].sort();
    if (unmappable.length > 0) throw new UnmappableScriptError(unmappable.sort());
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
   *
   * A script recorded through its source map therefore contributes no blocks:
   * projecting its ranges onto the original sources is separate work. Selection
   * treats a file with no recorded blocks as file-level, so such a source is
   * matched whole — over-selecting rather than under-selecting until then.
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
