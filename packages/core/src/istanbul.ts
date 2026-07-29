import { readFileSync } from 'node:fs';

import { type ExecRegion, positionToOffset, selectExecutedBlocks } from './blocks.js';
import type { CovselConfig } from './config.js';
import { makeSourceFilter } from './discover.js';
import type { RecordedTest } from './interfaces.js';
import { hashFileContents, toRepoRelative } from './paths.js';
import type { CoveredBlock, CoveredFile } from './schema.js';

/**
 * Reading an istanbul-shaped coverage report.
 *
 * Runners that execute transformed sources through their own module runner —
 * Vitest, Jest — cannot be observed at the process boundary: raw
 * `NODE_V8_COVERAGE` sees the transform output, not the files anyone wrote. Both
 * therefore record by asking the runner for its own coverage report, which is
 * already remapped to original sources, and reading it.
 *
 * That reading lived twice, once per adapter, because adapters may not depend on
 * each other and there was nowhere shared to put it. Two copies of a parser is a
 * nuisance; two copies of *this* parser is a hazard, because it decides which
 * sources a test is credited with. A fix applied to one and not the other leaves
 * one runner under-recording, which is the fail-closed direction — a test that
 * needed to run, skipped.
 *
 * A malformed entry contributes nothing rather than throwing. Throwing during
 * recording fails the whole test file, while a skipped entry only under-credits
 * within a path that is already guarded: an entry crediting nothing reads as a
 * test that covers nothing, which is what `observes` and the unmappable-script
 * check exist to catch.
 */

/** A line/column pair as istanbul reports it (lines 1-based, columns 0-based). */
export interface IstanbulPosition {
  line: number;
  column: number;
}

/** One file's entry in an istanbul-shaped `coverage-final.json`. */
export interface CoverageFinalEntry {
  path?: string;
  /** Statement hit counts by id. */
  s?: Record<string, number>;
  /** Function hit counts by id. */
  f?: Record<string, number>;
  /** Branch hit counts by id, one count per branch path. */
  b?: Record<string, number[]>;
  fnMap?: Record<string, { loc?: { start: IstanbulPosition; end: IstanbulPosition } }>;
}

/** A whole report: one entry per file the runner instrumented. */
export type IstanbulReport = Record<string, CoverageFinalEntry>;

/**
 * Read a report from disk, or `undefined` when there is nothing usable there.
 *
 * Deliberately no diagnostic: what a missing report *means* is runner-specific —
 * a missing coverage provider for one, an overridden reporter setting for another
 * — and core has no business guessing which. The caller knows, and says so.
 */
export function readIstanbulReport(file: string): IstanbulReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as IstanbulReport;
}

/** True when any counter in the entry recorded a hit. */
export function istanbulExecuted(entry: CoverageFinalEntry): boolean {
  const anyCount = (counts?: Record<string, number>): boolean =>
    counts !== undefined && Object.values(counts).some((c) => c > 0);
  const anyBranch = (b?: Record<string, number[]>): boolean =>
    b !== undefined && Object.values(b).some((arr) => arr.some((c) => c > 0));
  return anyCount(entry.s) || anyCount(entry.f) || anyBranch(entry.b);
}

/** Executed blocks of one source, from its istanbul function map and hit counts. */
export function istanbulBlocks(
  entry: CoverageFinalEntry,
  rel: string,
  abs: string,
): CoveredBlock[] {
  let source: string;
  try {
    source = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const toOffset = positionToOffset(source);
  const regions: ExecRegion[] = [];
  for (const [id, fn] of Object.entries(entry.fnMap ?? {})) {
    if (!fn.loc) continue;
    regions.push({
      start: toOffset(fn.loc.start.line, fn.loc.start.column),
      end: toOffset(fn.loc.end.line, fn.loc.end.column),
      count: entry.f?.[id] ?? 0,
    });
  }
  return selectExecutedBlocks(source, rel, regions).map((b) => ({
    file: rel,
    blockHash: b.hash,
  }));
}

export interface IstanbulCoverageInit {
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs' | 'granularity'>;
}

/**
 * Turn a report into the covered files and blocks a `RecordedUnit` carries.
 *
 * Only sources inside the repository that the project counts as sources are kept,
 * and only those the report says actually ran. Blocks follow the configured
 * granularity, so a project asking for file granularity does not pay to hash
 * every function it executed.
 */
export function istanbulCoverage(
  report: IstanbulReport,
  init: IstanbulCoverageInit,
): RecordedTest {
  const isSource = makeSourceFilter(init.config);
  const wantBlocks = init.config.granularity !== 'file';
  const files: CoveredFile[] = [];
  const blocks: CoveredBlock[] = [];
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(report)) {
    if (typeof entry !== 'object' || entry === null) continue;
    // The key is a path in every report seen in the wild, and `path` repeats it.
    // Preferring `path` and falling back to the key covers both.
    const abs = entry.path ?? key;
    const rel = toRepoRelative(init.cwd, abs);
    if (rel === undefined || !isSource(rel) || seen.has(rel)) continue;
    if (!istanbulExecuted(entry)) continue;
    seen.add(rel);
    files.push({ file: rel, fileHash: hashFileContents(abs) });
    if (wantBlocks) blocks.push(...istanbulBlocks(entry, rel, abs));
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files, blocks };
}
