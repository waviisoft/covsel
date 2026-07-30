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
 * The bias here is the project's, and it decides every judgement call below. A
 * region saying "ran" can only cause more tests to run. A region saying "did not
 * run" can cause a test to be skipped, because `executedAt` gives the narrowest
 * region over a block's probe the final word. So a zero-count region is only
 * emitted where the mappings positively establish one, and everything uncertain
 * — a map that disagrees with the text, a span that is not the range's own, a
 * source whose text is unavailable — resolves to saying nothing, which leaves
 * the block executed.
 */

import { type ExecRegion } from './blocks.js';
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
   * Ranges that produced no region at all — whatever the reason. Bundler runtime
   * the map is silent about, a source whose text could not be supplied, a span
   * this refused to guess at. Named rather than discarded so a caller can report
   * the gap, and deliberately contributing nothing, so a block whose probe falls
   * inside one stays executed.
   */
  unprojected: GeneratedRange[];
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_VALUE = new Map<string, number>(
  [...BASE64].map((char, index) => [char, index]),
);

/** Past this the accumulated value exceeds what the bitwise steps below keep. */
const MAX_VLQ_SHIFT = 30;

/**
 * One decoded VLQ field. Returns `undefined` for anything malformed — an
 * unknown character, a field that ends mid-continuation, or a value too wide to
 * survive the bitwise unpacking — so a map covsel cannot read leaves its ranges
 * unprojected rather than half-placed at wrong offsets.
 */
function decodeVlq(field: string): number[] | undefined {
  const values: number[] = [];
  let shift = 0;
  let value = 0;
  for (const char of field) {
    const digit = BASE64_VALUE.get(char);
    if (digit === undefined) return undefined;
    if (shift > MAX_VLQ_SHIFT) return undefined;
    const isContinued = (digit & 32) !== 0;
    value += (digit & 31) * 2 ** shift;
    if (isContinued) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    value >>>= 1;
    values.push(negative ? -value : value);
    shift = 0;
    value = 0;
  }
  return shift === 0 ? values : undefined;
}

/** One decoded mapping segment. Line and column numbers are 0-based. */
export interface MappingSegment {
  genLine: number;
  genCol: number;
  /** Absent for a segment that maps to no source — a mapping "hole". */
  sourceIndex?: number;
  origLine?: number;
  origCol?: number;
}

/**
 * Decode a `mappings` string into segments. Source, line, and column deltas run
 * across lines; the generated column resets on each. Anything that will not
 * decode — including an empty field between two commas — abandons the whole map
 * rather than yielding a partial one, since a half-decoded map places segments
 * at offsets that belong to other code.
 */
export function decodeMappings(mappings: string): MappingSegment[] | undefined {
  const segments: MappingSegment[] = [];
  let sourceIndex = 0;
  let origLine = 0;
  let origCol = 0;
  const lines = mappings.split(';');
  for (let genLine = 0; genLine < lines.length; genLine++) {
    const line = lines[genLine] ?? '';
    // A generated line with no mappings is ordinary, unlike an empty field.
    if (line === '') continue;
    let genCol = 0;
    for (const field of line.split(',')) {
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

/**
 * Line starts for a text, turning a segment's line/column into an offset.
 *
 * `undefined` for a line the text does not have. That case is not exotic: the
 * file on disk is read now and the map was written at build time, so a source
 * shortened since then maps past its own end. Answering with an offset near the
 * top of the file — which is what a bare lookup does — would put a region over
 * the wrong code entirely.
 */
interface TextPlacer {
  offsetAt(line0: number, col0: number): number | undefined;
  length: number;
}

function placerFor(text: string): TextPlacer {
  const lineStart = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStart.push(i + 1);
  }
  return {
    length: text.length,
    offsetAt(line0, col0) {
      const start = lineStart[line0];
      if (start === undefined) return undefined;
      // Clamp into the line, so a column past its end cannot drift into the
      // next one and carry a region with it.
      const limit = (lineStart[line0 + 1] ?? text.length + 1) - 1;
      return Math.min(start + col0, Math.max(start, limit));
    },
  };
}

/** A segment placed in both coordinate systems. */
interface PlacedSegment {
  genOffset: number;
  source: string;
  origOffset: number;
}

/** A segment that named a source, whether or not it could be placed. */
interface TouchedSegment {
  genOffset: number;
  source: string;
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

/** The first index in a genOffset-sorted list at or after `offset`. */
function lowerBound(list: readonly { genOffset: number }[], offset: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((list[mid] as { genOffset: number }).genOffset < offset) low = mid + 1;
    else high = mid;
  }
  return low;
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
  const generatedPlacer = placerFor(generated);
  const placers = new Map<string, TextPlacer | undefined>();
  const placerOf = (source: string): TextPlacer | undefined => {
    if (placers.has(source)) return placers.get(source);
    const text = sourceText(source);
    const placer = text === undefined ? undefined : placerFor(text);
    placers.set(source, placer);
    return placer;
  };

  const placed: PlacedSegment[] = [];
  const touched: TouchedSegment[] = [];
  /**
   * Sources whose map and text disagree — a segment pointing past the end of the
   * text they were supposed to describe. Every segment for such a source is
   * dropped, not just the impossible one: the pair cannot be trusted to say
   * where anything is, so nothing derived from it may claim a source did not
   * run.
   */
  const distrusted = new Set<string>();

  for (const segment of decoded) {
    if (segment.sourceIndex === undefined) continue;
    const source = sources[segment.sourceIndex];
    if (source === undefined) continue;
    const genOffset = generatedPlacer.offsetAt(segment.genLine, segment.genCol);
    // A map that describes lines the script does not have describes some other
    // script. Nothing can be placed from it.
    if (genOffset === undefined) continue;
    touched.push({ genOffset, source });
    const placer = placerOf(source);
    if (placer === undefined) continue;
    const origOffset = placer.offsetAt(segment.origLine ?? 0, segment.origCol ?? 0);
    if (origOffset === undefined) {
      distrusted.add(source);
      continue;
    }
    placed.push({ genOffset, source, origOffset });
  }

  const usable =
    distrusted.size === 0 ? placed : placed.filter((s) => !distrusted.has(s.source));
  usable.sort((a, b) => a.genOffset - b.genOffset);
  touched.sort((a, b) => a.genOffset - b.genOffset);

  // Every original offset a source is mapped at, so a region can end where the
  // next mapped construct begins rather than at a guessed width. Generated and
  // original spans are not the same length, so the extent has to come from the
  // mappings, never from the range's own width.
  const offsetsBySource = new Map<string, number[]>();
  for (const segment of usable) {
    const list = offsetsBySource.get(segment.source);
    if (list === undefined) offsetsBySource.set(segment.source, [segment.origOffset]);
    else list.push(segment.origOffset);
  }
  for (const [source, list] of offsetsBySource) {
    offsetsBySource.set(
      source,
      [...new Set(list)].sort((a, b) => a - b),
    );
  }

  // Where each original offset is reachable from in the generated script. An
  // original offset with more than one generated home is code the build inlined
  // into several callers, and the copies do not share a fate: one can run while
  // another never does.
  const homesByOffset = new Map<string, Map<number, number[]>>();
  for (const segment of usable) {
    let forSource = homesByOffset.get(segment.source);
    if (forSource === undefined) {
      forSource = new Map();
      homesByOffset.set(segment.source, forSource);
    }
    const homes = forSource.get(segment.origOffset);
    if (homes === undefined) forSource.set(segment.origOffset, [segment.genOffset]);
    else homes.push(segment.genOffset);
  }

  const endAfter = (source: string, offset: number): number => {
    for (const candidate of offsetsBySource.get(source) ?? []) {
      if (candidate > offset) return candidate;
    }
    const length = placers.get(source)?.length ?? -1;
    return length > offset ? length : offset + 1;
  };

  const regions = new Map<string, ExecRegion[]>();
  const unprojected: GeneratedRange[] = [];
  for (const range of ranges) {
    const bySource = new Map<string, number[]>();
    for (let i = lowerBound(usable, range.start); i < usable.length; i++) {
      const segment = usable[i] as PlacedSegment;
      if (segment.genOffset >= range.end) break;
      const list = bySource.get(segment.source);
      if (list === undefined) bySource.set(segment.source, [segment.origOffset]);
      else list.push(segment.origOffset);
    }

    // A range that reaches several sources is a callee inlined into its caller.
    // Crediting all of them over-selects, which is the safe direction — but only
    // for a range that ran. Saying "did not run" about several sources on the
    // strength of one ambiguous range is how a test gets skipped. The count has
    // to come from every source the range touched, including those dropped for
    // want of text: otherwise missing information disarms the very guard that
    // missing information calls for.
    if (range.count === 0) {
      const reached = new Set<string>();
      for (let i = lowerBound(touched, range.start); i < touched.length; i++) {
        const segment = touched[i] as TouchedSegment;
        if (segment.genOffset >= range.end) break;
        reached.add(segment.source);
      }
      if (reached.size > 1) {
        unprojected.push(range);
        continue;
      }
    }

    let emitted = 0;
    for (const [source, offsets] of bySource) {
      let start = Infinity;
      let last = -Infinity;
      for (const offset of offsets) {
        if (offset < start) start = offset;
        if (offset > last) last = offset;
      }
      const end = endAfter(source, last);

      // The span from the first to the last of a range's segments is a hull, and
      // a hull is only honest when the range owns all of it. Segments of this
      // source that fall inside it but belong to some other range mean the
      // original code is not contiguous, and a zero-count hull would then cover
      // code that ran — invisibly, when that code was inlined and so has no
      // range of its own to rescue it. A range that ran may keep its hull, since
      // widening "ran" only over-selects.
      if (range.count === 0) {
        const mine = new Set(offsets);
        const all = offsetsBySource.get(source) ?? [];
        const foreign = all.some((o) => o >= start && o <= last && !mine.has(o));
        if (foreign) continue;

        // Original code the build inlined into more than one place is reachable
        // from generated offsets this range does not cover. This range going
        // unexecuted says nothing about those copies, and one of them running is
        // enough for the code to have run — so the range may not call it idle.
        const homes = homesByOffset.get(source);
        const inlinedElsewhere = offsets.some((offset) =>
          (homes?.get(offset) ?? []).some(
            (genOffset) => genOffset < range.start || genOffset >= range.end,
          ),
        );
        if (inlinedElsewhere) continue;
      }

      emitted += 1;
      const region: ExecRegion = { start, end, count: range.count };
      const list = regions.get(source);
      if (list === undefined) regions.set(source, [region]);
      else list.push(region);
    }
    if (emitted === 0) unprojected.push(range);
  }
  return { regions, unprojected };
}
