import { describe, expect, it } from 'vitest';

import { selectExecutedBlocks } from '../src/blocks.js';
import { decodeMappings, type GeneratedRange, projectRanges } from '../src/project.js';
import type { RawSourceMap } from '../src/source-map.js';

/**
 * Base64 VLQ, so a fixture can be written as the segments it means rather than
 * as an opaque string. The encoder is the decoder's inverse and nothing else
 * depends on it, so a bug here shows up as a failing fixture, not as a pass.
 */
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeVlq(value: number): string {
  let bits = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = bits & 31;
    bits >>>= 5;
    if (bits > 0) digit |= 32;
    out += BASE64[digit];
  } while (bits > 0);
  return out;
}

/** [generatedColumn, sourceIndex, originalLine, originalColumn], all 0-based. */
type Segment = [number, number, number, number] | [number];

/** Build a `mappings` string from per-generated-line segments. */
function mappings(lines: Segment[][]): string {
  let sourceIndex = 0;
  let origLine = 0;
  let origCol = 0;
  return lines
    .map((segments) => {
      let genCol = 0;
      return segments
        .map((segment) => {
          const fields = [segment[0] - genCol];
          genCol = segment[0];
          if (segment.length === 4) {
            fields.push(
              segment[1] - sourceIndex,
              segment[2] - origLine,
              segment[3] - origCol,
            );
            sourceIndex = segment[1];
            origLine = segment[2];
            origCol = segment[3];
          }
          return fields.map(encodeVlq).join('');
        })
        .join(',');
    })
    .join(';');
}

const A_SOURCE = [
  'export const aTop = 1;',
  'export function fromA() {',
  '  return 1;',
  '}',
  '',
].join('\n');
const B_SOURCE = [
  'export const bTop = 2;',
  'export function fromB() {',
  '  return 2;',
  '}',
  '',
].join('\n');

/**
 * One line of bundle fusing both sources, as a bundler would: nobody's file on
 * disk. Each module contributes a top-level statement as well as a function, so
 * a function's own range covers a strict subset of its module's segments — the
 * difference that lets "the module loaded" and "this function never ran" be
 * told apart.
 *
 * offsets: 0            13               30       39           52           69
 */
const FUSED =
  'const aTop=1;function fromA(){return 1}const bTop=2;function fromB(){return 2}';

const FUSED_MAP: RawSourceMap = {
  version: 3,
  sources: ['src/a.ts', 'src/b.ts'],
  mappings: mappings([
    [
      [0, 0, 0, 0], // `const aTop=1;`      -> a.ts line 1
      [13, 0, 1, 0], // `function fromA(){` -> a.ts line 2
      [30, 0, 2, 2], // `return 1`          -> a.ts line 3, col 2
      [39, 1, 0, 0], // `const bTop=2;`     -> b.ts line 1
      [52, 1, 1, 0], // `function fromB(){` -> b.ts line 2
      [69, 1, 2, 2], // `return 2`          -> b.ts line 3, col 2
    ],
  ]),
};

/** The V8 ranges for that bundle: the script ran, `fromA` ran, `fromB` did not. */
const SCRIPT_RANGE: GeneratedRange = { start: 0, end: FUSED.length, count: 1 };
const FROM_A_RANGE: GeneratedRange = { start: 13, end: 39, count: 3 };
const FROM_B_RANGE: GeneratedRange = { start: 52, end: 78, count: 0 };

const textOf = (source: string): string | undefined =>
  source === 'src/a.ts' ? A_SOURCE : source === 'src/b.ts' ? B_SOURCE : undefined;

const project = (ranges: GeneratedRange[], map = FUSED_MAP, generated = FUSED) =>
  projectRanges({ map, generated, ranges, sourceText: textOf });

describe('projecting V8 ranges through a source map', () => {
  it('lands ranges in a fused chunk on the original sources', () => {
    // Only a.ts's function ran; b.ts's is present and never called. The
    // script-level range is included because V8 reports one, and it did run —
    // both modules' top level executed when the bundle loaded.
    const { regions } = project([SCRIPT_RANGE, FROM_A_RANGE, FROM_B_RANGE]);

    const inA = regions.get('src/a.ts') ?? [];
    const inB = regions.get('src/b.ts') ?? [];

    // What decides a block is the narrowest region over its probe, so that is
    // what the projection has to get right: a's body sits under a region that
    // ran, b's under one that did not.
    const narrowestAt = (list: typeof inA, probe: number) =>
      list
        .filter((r) => r.start <= probe && probe < r.end)
        .sort((x, y) => x.end - x.start - (y.end - y.start))[0];

    expect(narrowestAt(inA, A_SOURCE.indexOf('return 1'))?.count).toBeGreaterThan(0);
    expect(narrowestAt(inB, B_SOURCE.indexOf('return 2'))?.count).toBe(0);
  });

  it("selects a's block and not b's from the projection", () => {
    const { regions } = project([SCRIPT_RANGE, FROM_A_RANGE, FROM_B_RANGE]);

    const aBlocks = selectExecutedBlocks(
      A_SOURCE,
      'src/a.ts',
      regions.get('src/a.ts') ?? [],
    );
    const bBlocks = selectExecutedBlocks(
      B_SOURCE,
      'src/b.ts',
      regions.get('src/b.ts') ?? [],
    );
    expect(aBlocks.map((b) => b.name)).toContain('fromA');
    expect(bBlocks.map((b) => b.name)).not.toContain('fromB');
  });

  it("keeps an anonymous function's execution, which a function map would drop", () => {
    // The measured `v8-to-istanbul` failure: an arrow handler that ran, reported
    // by raw V8 with a correct count, absent from the conversion's `fnMap`.
    const main = ['export const handler = () => {', '  return 42;', '};', ''].join('\n');
    const generated = 'const handler=()=>{return 42};';
    const map: RawSourceMap = {
      version: 3,
      sources: ['src/main.ts'],
      mappings: mappings([
        [
          [0, 0, 0, 0],
          [19, 0, 1, 2], // the arrow body -> main.ts line 2
        ],
      ]),
    };

    const { regions } = projectRanges({
      map,
      generated,
      ranges: [{ start: 19, end: 29, count: 1 }],
      sourceText: (s) => (s === 'src/main.ts' ? main : undefined),
    });

    const inMain = regions.get('src/main.ts') ?? [];
    expect(inMain.some((r) => r.count > 0)).toBe(true);
    const body = main.indexOf('return 42');
    expect(inMain.some((r) => r.start <= body && body < r.end && r.count > 0)).toBe(true);
  });

  it('does not attribute injected code to a source, and reports it unprojected', () => {
    // The measured Vite failure: a modulepreload polyfill carrying no mapping,
    // attributed to `sources[0]` as phantom never-ran regions.
    const withPolyfill = `${'(function polyfill(){})();'}${FUSED}`;
    const shift = '(function polyfill(){})();'.length;
    const shifted: RawSourceMap = {
      ...FUSED_MAP,
      mappings: mappings([
        [
          [shift + 0, 0, 0, 0],
          [shift + 13, 0, 1, 0],
          [shift + 30, 0, 2, 2],
          [shift + 39, 1, 0, 0],
          [shift + 52, 1, 1, 0],
          [shift + 69, 1, 2, 2],
        ],
      ]),
    };

    const polyfill: GeneratedRange = { start: 0, end: shift, count: 0 };
    const { regions, unprojected } = project(
      [polyfill, { start: shift + 13, end: shift + 39, count: 1 }],
      shifted,
      withPolyfill,
    );

    expect(unprojected).toEqual([polyfill]);
    for (const list of regions.values()) {
      expect(list.every((r) => r.start >= 0)).toBe(true);
    }
    // Nothing the polyfill did lands on a.ts as a never-ran region.
    expect((regions.get('src/a.ts') ?? []).some((r) => r.count === 0)).toBe(false);
  });

  it('never lets an unprojected range mask an executed block', () => {
    const { regions, unprojected } = project([
      { start: 13, end: 39, count: 0 },
      FROM_B_RANGE,
    ]);
    expect(unprojected).toEqual([]);

    // Both ranges say "did not run", so the projection says so too — and the
    // module block still survives, because the file loaded.
    const aBlocks = selectExecutedBlocks(
      A_SOURCE,
      'src/a.ts',
      regions.get('src/a.ts') ?? [],
    );
    expect(aBlocks.map((b) => b.name)).not.toContain('fromA');

    // With nothing projected, every block stays executed rather than being lost.
    const noRegions = selectExecutedBlocks(A_SOURCE, 'src/a.ts', []);
    expect(noRegions.map((b) => b.name)).toContain('fromA');
  });

  it('drops a zero-count range that reaches several sources rather than guessing', () => {
    // An inlined callee: one range, two sources. Crediting both with "did not
    // run" would skip a test; crediting both with "ran" only runs more.
    const { regions } = project([{ start: 0, end: FUSED.length, count: 0 }]);
    expect(regions.size).toBe(0);

    const { regions: ran } = project([{ start: 0, end: FUSED.length, count: 2 }]);
    expect([...ran.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('falls open on an index map rather than reading segments against the wrong sources', () => {
    const sectioned: RawSourceMap = { version: 3, sections: [{ map: FUSED_MAP }] };
    const ranges = [FROM_A_RANGE];
    const { regions, unprojected } = project(ranges, sectioned);
    expect(regions.size).toBe(0);
    expect(unprojected).toEqual(ranges);
  });

  it('falls open on a map whose mappings will not decode', () => {
    const broken: RawSourceMap = { ...FUSED_MAP, mappings: 'not*valid' };
    const ranges = [FROM_A_RANGE];
    const { regions, unprojected } = project(ranges, broken);
    expect(regions.size).toBe(0);
    expect(unprojected).toEqual(ranges);
  });

  it('skips a source whose text cannot be supplied instead of placing it blind', () => {
    const { regions } = projectRanges({
      map: FUSED_MAP,
      generated: FUSED,
      ranges: [SCRIPT_RANGE],
      sourceText: (s) => (s === 'src/a.ts' ? A_SOURCE : undefined),
    });
    expect([...regions.keys()]).toEqual(['src/a.ts']);
  });
});

describe('decodeMappings', () => {
  it('carries source, line, and column deltas across generated lines', () => {
    const decoded = decodeMappings(mappings([[[0, 0, 0, 0]], [[4, 1, 2, 6]]]));
    expect(decoded).toEqual([
      { genLine: 0, genCol: 0, sourceIndex: 0, origLine: 0, origCol: 0 },
      { genLine: 1, genCol: 4, sourceIndex: 1, origLine: 2, origCol: 6 },
    ]);
  });

  it('keeps a one-field segment as a mapping hole', () => {
    const decoded = decodeMappings(mappings([[[0, 0, 0, 0], [9]]]));
    expect(decoded?.[1]).toEqual({ genLine: 0, genCol: 9 });
  });

  it('rejects a malformed field rather than returning a partial map', () => {
    expect(decodeMappings('AA*A')).toBeUndefined();
  });
});
