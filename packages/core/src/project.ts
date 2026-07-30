/**
 * Projecting V8 coverage ranges onto the sources a bundler fused together.
 *
 * V8 reports coverage in offsets into the script that executed. When that script
 * is a bundle, those offsets describe nobody's source file, and blocks hashed
 * from them are meaningless. This module reads the script's source map and
 * reports, per original source, which regions of it ran — plus an explicit
 * account of the ranges it could not place at all.
 *
 * It works from the ranges themselves rather than from an istanbul conversion,
 * because the conversions available lose exactly the cases that matter. Their
 * function maps carry named functions only, so an executed arrow handler
 * disappears and every block in its file is then credited to every test; and
 * bundler-injected code that carries no mapping is attributed to the map's first
 * source, grafting phantom never-ran regions onto a real file. Both failures
 * drop blocks, which drops tests.
 *
 * The bias here is the project's: a region that says "ran" can only cause more
 * tests to run, while one that says "did not run" can cause a test to be
 * skipped. Uncertainty therefore resolves toward saying nothing, which leaves
 * `selectExecutedBlocks` treating the block as executed.
 */

import { type ExecRegion, positionToOffset } from './blocks.js';
import { indexedSources, type RawSourceMap } from './source-map.js';

/** A V8 coverage range, in offsets into the script that executed. */
export interface GeneratedRange {
  start: number;
  end: number;
  count: number;
}

/** What projecting a script's ranges produced. */
export interface ProjectedCoverage {
  /**
   * Executed regions per original source, keyed as the map names it, in that
   * source's own character offsets. Ready for `selectExecutedBlocks`.
   */
  regions: Map<string, ExecRegion[]>;
  /**
   * Ranges that reached no original source: bundler runtime, injected polyfills,
   * anything the map is silent about. Named rather than discarded so a caller
   * can report the gap — and deliberately contributing no regions, so a block
   * whose probe falls inside one stays executed.
   */
  unprojected: GeneratedRange[];
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_VALUE = new Map<string, number>(
  [...BASE64].map((char, index) => [char, index]),
);

/**
 * One decoded VLQ field. Returns `undefined` for anything malformed, so a map
 * covsel cannot read leaves its ranges unprojected rather than half-placed.
 */
function decodeVlq(field: string): number[] | undefined {
  const values: number[] = [];
  let shift = 0;
  let value = 0;
  for (const char of field) {
    const digit = BASE64_VALUE.get(char);
    if (digit === undefined) return undefined;
    const isContinued = (digit & 32) !== 0;
    value += (digit & 31) * 2 ** shift;
    if (isContinued) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    value >>>= 1;
    values.push(negative ? (value === 0 ? -0 : -value) : value);
    shift = 0;
    value = 0;
  }
  return shift === 0 ? values : undefined;
}

interface Segment {
  genLine: number;
  genCol: number;
  /** Absent for a segment that maps to no source — a mapping "hole". */
  sourceIndex?: number;
  origLine?: number;
  origCol?: number;
}

/**
 * Decode a `mappings` string into segments. Source, line, and column deltas run
 * across lines; the generated column resets on each. A field that will not
 * decode aborts the whole map rather than yielding a partial one.
 */
export function decodeMappings(mappings: string): Segment[] | undefined {
  const segments: Segment[] = [];
  let sourceIndex = 0;
  let origLine = 0;
  let origCol = 0;
  const lines = mappings.split(';');
  for (let genLine = 0; genLine < lines.length; genLine++) {
    const line = lines[genLine] ?? '';
    if (line === '') continue;
    let genCol = 0;
    for (const field of line.split(',')) {
      if (field === '') continue;
      const values = decodeVlq(field);
      if (values === undefined || values.length === 0) return undefined;
      genCol += values[0] as number;
      if (values.length === 1) {
        segments.push({ genLine, genCol });
        continue;
      }
      if (values.length < 4) return undefined;
      sourceIndex += values[1] as number;
      origLine += values[2] as number;
      origCol += values[3] as number;
      segments.push({ genLine, genCol, sourceIndex, origLine, origCol });
    }
  }
  return segments;
}

/** A segment placed in both coordinate systems. */
interface PlacedSegment {
  genOffset: number;
  source: string;
  origOffset: number;
}

export interface ProjectRangesInit {
  /** The script's source map, already located and loaded. */
  map: RawSourceMap;
  /** The text of the script that executed, which the V8 offsets index. */
  generated: string;
  /** The V8 ranges to project. */
  ranges: readonly GeneratedRange[];
  /**
   * The original text behind a source the map names, for turning its
   * line/column mappings into offsets. A source this cannot supply is skipped:
   * without its text there is no offset to report, and guessing one would place
   * a region over the wrong bytes.
   */
  sourceText: (source: string) => string | undefined;
}

/**
 * Project a script's V8 ranges onto its original sources.
 *
 * Every range is projected, not only those a function map would name, so an
 * anonymous arrow that ran is reported exactly as a declared function would be.
 * A range reaching no source is reported as unprojected instead of being
 * attributed to one.
 *
 * An index map (one carrying `sections`) is not projected: its segments index
 * each section's own sources, and reading them against the top-level list would
 * attribute execution to whichever file happened to sit at that index. Every
 * range comes back unprojected instead, which falls open.
 */
export function projectRanges(init: ProjectRangesInit): ProjectedCoverage {
  const { map, generated, ranges, sourceText } = init;
  const empty = (): ProjectedCoverage => ({
    regions: new Map(),
    unprojected: [...ranges],
  });

  if (map.sections !== undefined) return empty();
  const decoded =
    typeof map.mappings === 'string' ? decodeMappings(map.mappings) : undefined;
  if (decoded === undefined) return empty();

  const sources = indexedSources(map);
  const genOffsetAt = positionToOffset(generated);
  const origOffsetAt = new Map<string, (line1: number, col0: number) => number>();
  const textLength = new Map<string, number>();
  const offsetAtFor = (
    source: string,
  ): ((line1: number, col0: number) => number) | undefined => {
    const known = origOffsetAt.get(source);
    if (known !== undefined) return known;
    if (textLength.has(source)) return undefined;
    const text = sourceText(source);
    if (text === undefined) {
      textLength.set(source, -1);
      return undefined;
    }
    const fn = positionToOffset(text);
    origOffsetAt.set(source, fn);
    textLength.set(source, text.length);
    return fn;
  };

  const placed: PlacedSegment[] = [];
  for (const segment of decoded) {
    if (segment.sourceIndex === undefined) continue;
    const source = sources[segment.sourceIndex];
    if (source === undefined) continue;
    const offsetAt = offsetAtFor(source);
    if (offsetAt === undefined) continue;
    placed.push({
      genOffset: genOffsetAt(segment.genLine + 1, segment.genCol),
      source,
      origOffset: offsetAt((segment.origLine ?? 0) + 1, segment.origCol ?? 0),
    });
  }
  placed.sort((a, b) => a.genOffset - b.genOffset);

  // Every original offset a source is mapped at, so a region can end where the
  // next mapped construct begins rather than at a guessed width. Generated and
  // original spans are not the same length, so the extent has to come from the
  // mappings, never from the range's own width.
  const offsetsBySource = new Map<string, number[]>();
  for (const segment of placed) {
    const list = offsetsBySource.get(segment.source);
    if (list === undefined) offsetsBySource.set(segment.source, [segment.origOffset]);
    else list.push(segment.origOffset);
  }
  for (const list of offsetsBySource.values()) list.sort((a, b) => a - b);

  const endAfter = (source: string, offset: number): number => {
    const list = offsetsBySource.get(source) ?? [];
    for (const candidate of list) if (candidate > offset) return candidate;
    const length = textLength.get(source) ?? -1;
    return length > offset ? length : offset + 1;
  };

  const regions = new Map<string, ExecRegion[]>();
  const unprojected: GeneratedRange[] = [];
  for (const range of ranges) {
    const inRange = placed.filter(
      (s) => s.genOffset >= range.start && s.genOffset < range.end,
    );
    if (inRange.length === 0) {
      unprojected.push(range);
      continue;
    }
    const bySource = new Map<string, number[]>();
    for (const segment of inRange) {
      const list = bySource.get(segment.source);
      if (list === undefined) bySource.set(segment.source, [segment.origOffset]);
      else list.push(segment.origOffset);
    }
    // A range that reaches several sources is a callee inlined into its caller.
    // Crediting all of them over-selects, which is the safe direction — but only
    // for a range that ran. Saying "did not run" about several sources on the
    // strength of one ambiguous range is how a test gets skipped, so a
    // zero-count range that cannot name one source is dropped, leaving those
    // blocks executed.
    if (range.count === 0 && bySource.size > 1) continue;
    for (const [source, offsets] of bySource) {
      const start = Math.min(...offsets);
      const last = Math.max(...offsets);
      const list = regions.get(source);
      const region: ExecRegion = {
        start,
        end: endAfter(source, last),
        count: range.count,
      };
      if (list === undefined) regions.set(source, [region]);
      else list.push(region);
    }
  }
  return { regions, unprojected };
}
