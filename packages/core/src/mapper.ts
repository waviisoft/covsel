import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type ExecRegion, selectExecutedBlocks } from './blocks.js';
import type { CovselConfig } from './config.js';
import { makeSourceFilter } from './discover.js';
import type { Mapper, RawCoverage } from './interfaces.js';
import { makeStrictMatcher } from './match.js';
import type { ScriptCoverage } from './observer.js';
import {
  DEFAULT_EXCLUDES,
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

/** One executed script covsel could not account for, and why. */
export interface UnmappableScript {
  /** The script's repo-relative path, or its URL when it has none. */
  script: string;
  /** What stopped it being resolved, in a sentence. */
  reason: string;
}

/**
 * Raised when a script executed and nothing could be said about what source it
 * came from. Recording one test file is all-or-nothing for the same reason the
 * whole map is: an entry that credits nothing is read as a test that covers
 * nothing, and there is no later stage that can tell the two apart.
 */
export class UnmappableScriptError extends Error {
  /** The scripts, with their reasons. */
  readonly unmappable: readonly UnmappableScript[];
  /** Just the script names, for callers that only report what failed. */
  readonly scripts: readonly string[];

  constructor(unmappable: readonly UnmappableScript[]) {
    super(
      `executed ${unmappable.length === 1 ? 'script' : 'scripts'} could not be mapped ` +
        `back to the sources behind them: ` +
        unmappable.map((u) => `${u.script} (${u.reason})`).join('; ') +
        '. Build with source maps enabled, point `sourceMaps.buildDirs` at the ' +
        'built assets, or accept the gap with `sourceMaps.allowUnmappable`.',
    );
    this.name = 'UnmappableScriptError';
    this.unmappable = unmappable;
    this.scripts = unmappable.map((u) => u.script);
  }
}

/** What one executed script contributed, once covsel worked out what it was. */
interface Attribution {
  /** Repo-relative sources to record for it. */
  sources: string[];
  /** Set when the script could not be resolved to the sources behind it. */
  unmappable?: UnmappableScript;
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
  /** Scripts let through unmapped since the caller last collected them. */
  private readonly allowed: string[] = [];

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
    const rel = this.repoRelative(url);
    if (rel === undefined || !this.isSource(rel)) return undefined;
    return { rel, abs: `${this.cwd}/${rel}` };
  }

  /** How a script is named in configuration and in failures: its path, or its URL. */
  private label(url: string): string {
    return this.repoRelative(url) ?? stripUrlQuery(url);
  }

  /**
   * What one executed script contributes, and whether covsel could account for
   * it at all.
   *
   * A script is accounted for when covsel knows what code it is, which is not
   * the same as recording it. Three kinds are accounted for by what they are:
   *
   * - **A file in the repository, outside the excluded directories**, is its own
   *   source. Recorded when it passes the source filter, and deliberately
   *   skipped when it does not — a test file, or a path the project put outside
   *   `sourceGlobs`.
   * - **Vendored code** under `node_modules` is outside what a recording maps by
   *   design; a dependency change is caught by the lockfile sentinel instead.
   * - **Foreign and runtime scripts** — a file outside the repository, a `node:`
   *   builtin, `eval` — are not this project's code.
   *
   * What is left is code built from this repository and handed back to the
   * runner: out of an excluded build directory, or over HTTP from a dev server.
   * It means nothing without its source map, so failing to resolve one is fatal.
   */
  private async attribute(url: string): Promise<Attribution> {
    const own = this.ownSource(url);
    if (own !== undefined) return await this.attributeOwnSource(url, own);
    if (this.isAccountedForAsItStands(url)) return { sources: [] };
    return await this.attributeBuiltScript(url);
  }

  /**
   * The repo-relative path of a script that is its own source: in the tree, and
   * not in a directory covsel treats as build output or vendored code. The path
   * is returned even when the source filter would reject it — a test file has an
   * identity, it is just not recorded.
   */
  private ownSource(url: string): string | undefined {
    const rel = this.repoRelative(url);
    if (rel === undefined || isExcludedRel(rel)) return undefined;
    return rel;
  }

  /**
   * True when a script needs no map to be accounted for: vendored code, a file
   * outside the repository, or anything the runtime itself loaded.
   */
  private isAccountedForAsItStands(url: string): boolean {
    if (/^https?:\/\//.test(url)) return false;
    if (!url.startsWith('file://')) return true; // `node:`, `data:`, eval, …
    const rel = this.repoRelative(url);
    if (rel === undefined) return true; // outside the repo: someone else's code
    return rel.split('/').includes('node_modules'); // vendored
  }

  /**
   * A script that is its own source. Its map, if it has one, adds the sources it
   * was built from — crediting both the emitted file and those over-selects,
   * which is the safe direction. Sources the map names but covsel cannot locate
   * are not fatal here: the entry already credits the file that executed, so a
   * change to it still selects the test. Only precision is lost, and escalating
   * would fail recordings that work today over a stale sidecar map.
   */
  private async attributeOwnSource(url: string, rel: string): Promise<Attribution> {
    const sources = this.isSource(rel) ? [rel] : [];
    const mapped = await this.resolver.resolve({ url });
    if (mapped.kind === 'mapped') sources.push(...mapped.sources.filter(this.isSource));
    return { sources };
  }

  /**
   * A script built from this repository and handed back to the runner. Its map
   * is the only way back to what it is, so anything short of a full resolution
   * is a hole: no map at all, a map naming nothing from this repository, or a
   * map naming sources that could be repo files but could not be pinned to one.
   */
  private async attributeBuiltScript(url: string): Promise<Attribution> {
    const label = this.label(url);
    // Say why a file that is right there in the tree is being asked to map at
    // all: it sits in a directory covsel reads as build output, which is not
    // obvious when the directory is a `coverage/` or `dist/` nested in sources.
    const because =
      this.repoRelative(url) === undefined
        ? ''
        : 'covsel reads this path as build output because a directory in it is ' +
          `one of ${DEFAULT_EXCLUDES.join(', ')} — `;
    const gap = (detail: string): Attribution => ({
      sources: [],
      unmappable: { script: label, reason: `${because}${detail}` },
    });

    if (this.isAllowedUnmappable(label)) return { sources: [], allowed: label };
    const mapped = await this.resolver.resolve({ url });
    if (mapped.kind === 'unmapped') return gap(mapped.reason);
    if (mapped.unresolved.length > 0) {
      return gap(
        `its source map names ${mapped.unresolved.length} source(s) this recording ` +
          `could not locate: ${mapped.unresolved.slice(0, 3).join(', ')}`,
      );
    }
    if (mapped.sources.length === 0) {
      return gap('its source map names no source in this repository');
    }
    return { sources: mapped.sources.filter(this.isSource) };
  }

  /** A script URL as a repo-relative path, when it is a file inside the repo. */
  private repoRelative(url: string): string | undefined {
    if (!url.startsWith('file://')) return undefined;
    try {
      return toRepoRelative(this.cwd, fileURLToPath(stripUrlQuery(url)));
    } catch {
      return undefined;
    }
  }

  /**
   * The scripts accepted without mapping them, because the project's
   * configuration says to, since this was last called. Reading clears the list,
   * so a recorder that maps several units per test file reports every unit's
   * gaps rather than only the last one's.
   */
  takeAllowedUnmappable(): string[] {
    return this.allowed.splice(0);
  }

  async toFiles(raw: RawCoverage): Promise<CoveredFile[]> {
    const covered = new Map<string, string>();
    const unmappable: UnmappableScript[] = [];
    for (const script of raw.scripts as ScriptCoverage[]) {
      const executed = script.functions.some((fn) => fn.ranges.some((r) => r.count > 0));
      if (!executed) continue;
      const attribution = await this.attribute(script.url);
      if (attribution.unmappable !== undefined) {
        const gap = attribution.unmappable;
        if (!unmappable.some((u) => u.script === gap.script)) unmappable.push(gap);
        continue;
      }
      if (
        attribution.allowed !== undefined &&
        !this.allowed.includes(attribution.allowed)
      ) {
        this.allowed.push(attribution.allowed);
      }
      for (const rel of attribution.sources) {
        if (covered.has(rel)) continue;
        // An unreadable source is left to throw, as it always has been: a
        // recording that cannot fingerprint what a test covered has to fail,
        // not quietly drop the file from the entry.
        covered.set(rel, hashFileContents(`${this.cwd}/${rel}`));
      }
    }
    if (unmappable.length > 0) {
      throw new UnmappableScriptError(
        [...unmappable].sort((a, b) => (a.script < b.script ? -1 : 1)),
      );
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
