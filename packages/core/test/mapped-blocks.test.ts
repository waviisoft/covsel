import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { write } from './helpers/repo.js';
import { resolveConfig, V8FileMapper } from '../src/index.js';

/**
 * Blocks for a script whose bytes are not the bytes on disk.
 *
 * A bundle is nobody's file, so V8's offsets into it describe nothing until they
 * are projected through its source map. Until that projection was wired in, such
 * a script contributed no blocks at all and selection fell back to matching the
 * whole file — safe, and no better than having no block granularity.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

/** One line of bundle fusing both sources, as a bundler would. */
const FUSED =
  'const aTop=1;function fromA(){return 1}const bTop=2;function fromB(){return 2}';

/** Base64 VLQ, so the fixture reads as the segments it means. */
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
function mappings(segments: [number, number, number, number][]): string {
  let genCol = 0;
  let sourceIndex = 0;
  let origLine = 0;
  let origCol = 0;
  return segments
    .map((s) => {
      const fields = [s[0] - genCol, s[1] - sourceIndex, s[2] - origLine, s[3] - origCol];
      [genCol, sourceIndex, origLine, origCol] = s;
      return fields.map(encodeVlq).join('');
    })
    .join(',');
}

function fixture(): { cwd: string; mapper: V8FileMapper; bundle: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-mapped-blocks-'));
  dirs.push(cwd);
  write(cwd, 'src/a.ts', A_SOURCE);
  write(cwd, 'src/b.ts', B_SOURCE);

  const map = {
    version: 3,
    sources: ['../src/a.ts', '../src/b.ts'],
    // What the build published, which is the text as it stood when the bundle
    // was made. Present here so the on-disk-text test has something wrong to
    // pick up if the mapper ever reads from the map instead.
    sourcesContent: [A_SOURCE, B_SOURCE],
    mappings: mappings([
      [0, 0, 0, 0],
      [13, 0, 1, 0],
      [30, 0, 2, 2],
      [39, 1, 0, 0],
      [52, 1, 1, 0],
      [69, 1, 2, 2],
    ]),
  };
  const bundle = join(cwd, 'dist/app.js');
  write(cwd, 'dist/app.js', `${FUSED}\n//# sourceMappingURL=app.js.map\n`);
  writeFileSync(join(cwd, 'dist/app.js.map'), JSON.stringify(map));

  return {
    cwd,
    bundle,
    mapper: new V8FileMapper({
      cwd,
      config: resolveConfig({ sourceGlobs: ['src/**'] }),
    }),
  };
}

/** V8's report for that bundle: the script ran, `fromA` ran, `fromB` did not. */
const coverageFor = (url: string) => ({
  scripts: [
    {
      url,
      functions: [
        { ranges: [{ startOffset: 0, endOffset: FUSED.length, count: 1 }] },
        { functionName: 'fromA', ranges: [{ startOffset: 13, endOffset: 39, count: 3 }] },
        { functionName: 'fromB', ranges: [{ startOffset: 52, endOffset: 78, count: 0 }] },
      ],
    },
  ],
});

describe('blocks for a source-mapped script', () => {
  it('records blocks against the original sources, not the bundle', async () => {
    const { mapper, bundle } = fixture();

    const blocks = await mapper.toBlocks(coverageFor(`file://${bundle}`));

    expect([...new Set(blocks.map((b) => b.file))].sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('records the function that ran and not the one that did not', async () => {
    const { mapper, bundle } = fixture();
    const { extractBlocks } = await import('../src/index.js');

    const blocks = await mapper.toBlocks(coverageFor(`file://${bundle}`));
    const hashesFor = (file: string, source: string) =>
      new Map(extractBlocks(source, file).map((b) => [b.hash, b.name]));

    const inA = blocks
      .filter((b) => b.file === 'src/a.ts')
      .map((b) => hashesFor('src/a.ts', A_SOURCE).get(b.blockHash));
    const inB = blocks
      .filter((b) => b.file === 'src/b.ts')
      .map((b) => hashesFor('src/b.ts', B_SOURCE).get(b.blockHash));

    expect(inA).toContain('fromA');
    expect(inB).not.toContain('fromB');
  });

  it('takes the block text from the file on disk, not the map’s sourcesContent', async () => {
    // A hash has to describe the file a diff will be taken against. The build's
    // published copy is what the bundle was made from, which is the wrong text
    // the moment anyone edits the source.
    const { cwd, mapper, bundle } = fixture();
    const { extractBlocks } = await import('../src/index.js');
    const edited = A_SOURCE.replace('return 1;', 'return 11;');
    write(cwd, 'src/a.ts', edited);

    const blocks = await mapper.toBlocks(coverageFor(`file://${bundle}`));

    const current = new Set(extractBlocks(edited, 'src/a.ts').map((b) => b.hash));
    const recorded = blocks.filter((b) => b.file === 'src/a.ts').map((b) => b.blockHash);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((h) => current.has(h))).toBe(true);
  });

  it('projects a script whose text the observation carried, with nothing on disk', async () => {
    // The browser case: the bundle was served, never written to the repository,
    // and the only copy of what the offsets index came back with the coverage.
    const { cwd, mapper } = fixture();
    const map = {
      version: 3,
      sources: ['src/a.ts'],
      // A map served over HTTP has no disk anchor, so covsel confirms each
      // source against the text the build published before crediting it — a
      // served path that merely matches a same-named repo file is a guess. Dev
      // servers emit this; without it the script resolves to nothing, which is
      // the refusal working rather than a failure to project.
      sourcesContent: [A_SOURCE],
      mappings: mappings([
        [0, 0, 0, 0],
        [13, 0, 1, 0],
        [30, 0, 2, 2],
      ]),
    };
    const inline = Buffer.from(JSON.stringify(map)).toString('base64');

    const blocks = await mapper.toBlocks({
      scripts: [
        {
          url: 'http://localhost:5173/assets/app.js',
          source: `${FUSED}\n//# sourceMappingURL=data:application/json;base64,${inline}\n`,
          functions: [{ ranges: [{ startOffset: 13, endOffset: 39, count: 2 }] }],
        },
      ],
    });

    expect(blocks.map((b) => b.file)).toContain('src/a.ts');
    expect(cwd).toBeDefined();
  });
});
