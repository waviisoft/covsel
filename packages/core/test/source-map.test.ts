import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type CovselConfig,
  decodeDataSourceMap,
  type RawCoverage,
  readSourceMappingURL,
  resolveConfig,
  SourceMapResolver,
  sourceMapSources,
  UnmappableScriptError,
  V8FileMapper,
} from '../src/index.js';

/**
 * Finding the sources behind a script, in the four shapes a build publishes
 * them: a sidecar file, an inline `data:` URI, a script the recorder only sees
 * over HTTP, and a build directory the served URLs map onto.
 */

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

function write(cwd: string, rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

const APP = `export function greet(name) {\n  return \`hello \${name}\`;\n}\n`;

/**
 * A source map. `contents` publishes `sourcesContent`, which is what lets an
 * unanchored resolution confirm a source rather than guess at it.
 */
function mapJson(sources: string[], contents?: (string | null)[]): string {
  return JSON.stringify({
    version: 3,
    file: 'app.js',
    sources,
    ...(contents ? { sourcesContent: contents } : {}),
    names: [],
    mappings: '',
  });
}

/** A repo whose `src/app.mjs` was built into `dist/assets/app.js`. */
function fixture(
  sources: string[],
  comment = '//# sourceMappingURL=app.js.map\n',
  contents?: (string | null)[],
): string {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-sourcemap-'));
  dirs.push(cwd);
  write(cwd, 'src/app.mjs', APP);
  write(cwd, 'dist/assets/app.js', APP + comment);
  write(cwd, 'dist/assets/app.js.map', mapJson(sources, contents));
  return cwd;
}

/** Serve a directory over HTTP on localhost, returning its base URL. */
async function serve(root: string): Promise<string> {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/').replace(
      /^\/+/,
      '',
    );
    try {
      res.writeHead(200).end(readFileSync(join(root, rel), 'utf8'));
    } catch {
      res.writeHead(404).end('');
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

describe('reading a sourceMappingURL', () => {
  it('takes the last comment the script declares', () => {
    const text = `code();\n//# sourceMappingURL=first.map\nmore();\n//# sourceMappingURL=last.map\n`;
    expect(readSourceMappingURL(text)).toBe('last.map');
  });

  it('reads the block-comment form bundlers emit for CSS-adjacent output', () => {
    expect(readSourceMappingURL(`code();\n/*# sourceMappingURL=app.map */\n`)).toBe(
      'app.map',
    );
  });

  it('ignores one mentioned inside code rather than in its own comment', () => {
    const text = `const s = '//# sourceMappingURL=nope.map';\n`;
    expect(readSourceMappingURL(text)).toBeUndefined();
  });

  it('is undefined when the script declares none', () => {
    expect(readSourceMappingURL('export const a = 1;\n')).toBeUndefined();
  });
});

describe('decoding an inline source map', () => {
  const map = mapJson(['../src/app.mjs']);

  it('decodes the base64 form', () => {
    const url = `data:application/json;charset=utf-8;base64,${Buffer.from(map).toString('base64')}`;
    expect(decodeDataSourceMap(url)?.sources).toEqual(['../src/app.mjs']);
  });

  it('decodes the percent-encoded form', () => {
    const url = `data:application/json,${encodeURIComponent(map)}`;
    expect(decodeDataSourceMap(url)?.sources).toEqual(['../src/app.mjs']);
  });

  it('is undefined for anything that is not a source map', () => {
    expect(decodeDataSourceMap('data:text/plain,hello')).toBeUndefined();
    expect(decodeDataSourceMap('./app.js.map')).toBeUndefined();
  });
});

describe('the sources a map names', () => {
  it('applies sourceRoot to relative sources', () => {
    expect(sourceMapSources({ sourceRoot: '../src', sources: ['a.ts', 'b.ts'] })).toEqual(
      ['../src/a.ts', '../src/b.ts'],
    );
  });

  it('follows the sections of an index map', () => {
    expect(
      sourceMapSources({
        sections: [{ map: { sources: ['a.ts'] } }, { map: { sources: ['b.ts'] } }],
      }),
    ).toEqual(['a.ts', 'b.ts']);
  });
});

describe('resolving a script to its sources', () => {
  it('follows a sidecar map next to a file on disk', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toEqual({
      kind: 'mapped',
      sources: ['src/app.mjs'],
      unresolved: [],
    });
  });

  it('drops a source that is definitely not this repository’s', async () => {
    // Someone else's absolute build path is not missing coverage — it is not
    // ours. Contrast with the test below, where the source could be a repo file.
    const cwd = fixture(['../../src/app.mjs', '/elsewhere/vendor.js']);
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toEqual({
      kind: 'mapped',
      sources: ['src/app.mjs'],
      unresolved: [],
    });
  });

  it('reports a source that should be here but is not, instead of dropping it', async () => {
    // The silent version of this is the whole bug: one source of many resolving
    // would otherwise count as a success, and the sources it could not find
    // would be missing from the entry with nothing to say so.
    const cwd = fixture(['../../src/app.mjs', '../../src/gone.mjs']);
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toEqual({
      kind: 'mapped',
      sources: ['src/app.mjs'],
      unresolved: ['../../src/gone.mjs'],
    });
  });

  it('ignores the synthetic modules a bundler lists beside real files', async () => {
    const cwd = fixture([
      '../../src/app.mjs',
      'vite/preload-helper',
      '\u0000commonjsHelpers.js',
    ]);
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toEqual({
      kind: 'mapped',
      sources: ['src/app.mjs'],
      unresolved: [],
    });
  });

  it('reports a script with no map as unmapped rather than as covering nothing', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    rmSync(join(cwd, 'dist/assets/app.js.map'));
    write(cwd, 'dist/assets/app.js', APP);
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toMatchObject({
      kind: 'unmapped',
      reason: expect.stringContaining('declares no sourceMappingURL'),
    });
  });

  it('uses the script text the observation carried, without going back for it', async () => {
    // Browser coverage hands over the script it profiled, which is the only copy
    // a recorder gets when the page built it in memory.
    const cwd = fixture(['../../src/app.mjs']);
    const inline = `data:application/json;base64,${Buffer.from(mapJson(['src/app.mjs'], [APP])).toString('base64')}`;
    const resolver = new SourceMapResolver({ cwd, http: false });

    expect(
      await resolver.resolve({
        url: 'http://localhost:5173/assets/index-abc.js',
        source: `${APP}//# sourceMappingURL=${inline}\n`,
      }),
    ).toEqual({ kind: 'mapped', sources: ['src/app.mjs'], unresolved: [] });
  });

  it('reads a served script from the build directory it was built into', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const resolver = new SourceMapResolver({
      cwd,
      buildDirs: [{ urlPrefix: 'http://localhost:5173/', dir: 'dist' }],
      http: false,
    });

    expect(
      await resolver.resolve({ url: 'http://localhost:5173/assets/app.js?t=17' }),
    ).toEqual({ kind: 'mapped', sources: ['src/app.mjs'], unresolved: [] });
  });

  it('will not let one build directory claim another origin’s assets', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const resolver = new SourceMapResolver({
      cwd,
      buildDirs: [{ urlPrefix: 'http://localhost:5173', dir: 'dist' }],
      http: false,
    });

    // A different port that merely starts with the same characters.
    expect(
      await resolver.resolve({ url: 'http://localhost:51730/assets/app.js' }),
    ).toMatchObject({ kind: 'unmapped' });
  });

  it('will not let a served path walk out of the directory it was mapped onto', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    write(cwd, 'secret.js', `${APP}//# sourceMappingURL=data:application/json,{}\n`);
    const resolver = new SourceMapResolver({
      cwd,
      buildDirs: [{ urlPrefix: 'http://localhost:5173/', dir: 'dist' }],
      http: false,
    });

    expect(
      await resolver.resolve({ url: 'http://localhost:5173/../secret.js' }),
    ).toMatchObject({ kind: 'unmapped' });
  });

  it('fetches the script and its map over HTTP, confirming sources by content', async () => {
    // What a browser recorder has: a URL, a dev server, and nothing local that
    // corresponds to it. A served path is only a guess at where the source lives
    // in the repository, so the content the build published is what settles it.
    const cwd = fixture(['/src/app.mjs'], undefined, [APP]);
    const base = await serve(join(cwd, 'dist'));
    const resolver = new SourceMapResolver({ cwd });

    expect(await resolver.resolve({ url: `${base}assets/app.js` })).toEqual({
      kind: 'mapped',
      sources: ['src/app.mjs'],
      unresolved: [],
    });
  }, 20_000);

  it('resolves a dev server’s source named relative to the script it serves', async () => {
    // The shape every Vite-family dev server produces, and the one a browser
    // recording is made of: the module is served at its own path and its map
    // names the source relative to *that* -- `/src/app.ts` answered with a map
    // naming `app.ts`. Read against the repo root alone it is looked for at the
    // top of the tree, found nowhere, and the whole recording fails on a source
    // that is sitting right there.
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-sourcemap-'));
    dirs.push(cwd);
    write(cwd, 'src/app.mjs', APP);
    const inline = Buffer.from(mapJson(['app.mjs'], [APP])).toString('base64');
    const url = 'http://127.0.0.1:5173/src/app.mjs';
    const resolver = new SourceMapResolver({
      cwd,
      fetchText: async (asked) =>
        asked === url
          ? `${APP}//# sourceMappingURL=data:application/json;base64,${inline}\n`
          : undefined,
    });

    expect(await resolver.resolve({ url })).toEqual({
      kind: 'mapped',
      sources: ['src/app.mjs'],
      unresolved: [],
    });
  });

  it('will not credit the file a served path points at when the build published other text', async () => {
    // The URL says where to look; it does not say the file there is the one that
    // was built. Reading the path as proof would credit a source the test never
    // executed, and lose every change to the one it did.
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-sourcemap-'));
    dirs.push(cwd);
    write(cwd, 'src/app.mjs', 'export function greet() {\n  return 42;\n}\n');
    const inline = Buffer.from(mapJson(['./app.mjs'], [APP])).toString('base64');
    const url = 'http://127.0.0.1:5173/src/app.mjs';
    const resolver = new SourceMapResolver({
      cwd,
      fetchText: async (asked) =>
        asked === url
          ? `${APP}//# sourceMappingURL=data:application/json;base64,${inline}\n`
          : undefined,
    });

    expect(await resolver.resolve({ url })).toEqual({
      kind: 'mapped',
      sources: [],
      unresolved: ['./app.mjs'],
    });
  });

  it('will not credit a same-named file when nothing confirms the guess', async () => {
    const cwd = fixture(['/src/app.mjs']);
    const base = await serve(join(cwd, 'dist'));
    const resolver = new SourceMapResolver({ cwd });

    expect(await resolver.resolve({ url: `${base}assets/app.js` })).toEqual({
      kind: 'mapped',
      sources: [],
      unresolved: ['/src/app.mjs'],
    });
  }, 20_000);

  it('will not credit a file whose content is not what was built', async () => {
    // The monorepo shape: the served source is `apps/web/src/app.mjs`, and an
    // unrelated `src/app.mjs` sits at the repo root. Crediting the root file
    // would lose every change to the one the test actually executed.
    const cwd = fixture(['/src/app.mjs'], undefined, [
      'export function greet() {\n  return 42;\n}\n',
    ]);
    const base = await serve(join(cwd, 'dist'));
    const resolver = new SourceMapResolver({ cwd });

    expect(await resolver.resolve({ url: `${base}assets/app.js` })).toEqual({
      kind: 'mapped',
      sources: [],
      unresolved: ['/src/app.mjs'],
    });
  }, 20_000);

  it('does not reach the network when HTTP loading is turned off', async () => {
    const cwd = fixture(['/src/app.mjs'], undefined, [APP]);
    const base = await serve(join(cwd, 'dist'));
    const resolver = new SourceMapResolver({ cwd, http: false });

    expect(await resolver.resolve({ url: `${base}assets/app.js` })).toMatchObject({
      kind: 'unmapped',
    });
  }, 20_000);

  it('does not follow a sourceMappingURL to another host', async () => {
    // The comment is content covsel did not write. Following it anywhere would
    // turn recording into a request generator pointed wherever a bundle says.
    const asked: string[] = [];
    const cwd = fixture(['../../src/app.mjs']);
    const resolver = new SourceMapResolver({
      cwd,
      fetchText: async (url) => {
        asked.push(url);
        if (url.endsWith('/app.js')) {
          return `${APP}//# sourceMappingURL=http://169.254.169.254/latest/meta-data\n`;
        }
        return undefined;
      },
    });

    expect(
      await resolver.resolve({ url: 'http://localhost:5173/assets/app.js' }),
    ).toEqual({
      kind: 'unmapped',
      reason: expect.stringContaining('169.254.169.254'),
    });
    expect(asked.some((url) => url.includes('169.254.169.254'))).toBe(false);
  });

  it('resolves a webpack-style source whose authority is part of the path', async () => {
    const cwd = fixture(['webpack://app/./lib/util.mjs'], undefined, [APP]);
    write(cwd, 'app/lib/util.mjs', APP);
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toEqual({
      kind: 'mapped',
      sources: ['app/lib/util.mjs'],
      unresolved: [],
    });
  });

  it('reports a webpack-style source it cannot place either way', async () => {
    const cwd = fixture(['webpack://app/./src/missing.mjs'], undefined, [APP]);
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toEqual({
      kind: 'mapped',
      sources: [],
      unresolved: ['webpack://app/./src/missing.mjs'],
    });
  });

  it('does not read an unrelated JSON body as a source map', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    write(cwd, 'dist/assets/app.js.map', '{"error":"not found"}');
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toMatchObject({ kind: 'unmapped' });
  });
});

describe('mapping coverage for scripts a runner only names by URL', () => {
  const config = resolveConfig({ sourceGlobs: ['src/**'] });
  const coverage = (...urls: string[]): RawCoverage => ({
    scripts: urls.map((url) => ({
      url,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }],
    })),
  });
  const withSourceMaps = (
    cwd: string,
    sourceMaps: Partial<CovselConfig['sourceMaps']>,
  ): V8FileMapper =>
    new V8FileMapper({
      cwd,
      config: {
        ...config,
        sourceMaps: { buildDirs: [], http: false, allowUnmappable: [], ...sourceMaps },
      },
    });

  it('records the sources behind a served bundle', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const mapper = withSourceMaps(cwd, {
      buildDirs: [{ urlPrefix: 'http://localhost:5173/', dir: 'dist' }],
    });

    const files = await mapper.toFiles(coverage('http://localhost:5173/assets/app.js'));
    expect(files.map((f) => f.file)).toEqual(['src/app.mjs']);
  });

  it('fails naming the script when there is no way back to its sources', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const mapper = withSourceMaps(cwd, {});

    await expect(
      mapper.toFiles(coverage('http://localhost:5173/assets/app.js')),
    ).rejects.toThrow(UnmappableScriptError);
    await expect(
      mapper.toFiles(coverage('http://localhost:5173/assets/app.js')),
    ).rejects.toThrow(/http:\/\/localhost:5173\/assets\/app\.js/);
  });

  it('fails when only some of a map’s sources could be located', async () => {
    // A partly resolved map used to count as a success, which put the missing
    // sources nowhere: the entry looked complete and was not.
    const cwd = fixture(['../../src/app.mjs', '../../src/gone.mjs']);
    const mapper = withSourceMaps(cwd, {
      buildDirs: [{ urlPrefix: 'http://localhost:5173/', dir: 'dist' }],
    });

    await expect(
      mapper.toFiles(coverage('http://localhost:5173/assets/app.js')),
    ).rejects.toThrow(/could not locate: \.\.\/\.\.\/src\/gone\.mjs/);
  });

  it('still records a repo file whose own map cannot be resolved', async () => {
    // The script is its own source, so the entry credits it either way. Failing
    // here would break projects that record fine today over a stale sidecar.
    const cwd = fixture(['../../src/app.mjs']);
    write(cwd, 'src/app.mjs', `${APP}//# sourceMappingURL=app.mjs.map\n`);
    write(cwd, 'src/app.mjs.map', mapJson(['./gone.ts']));
    const mapper = withSourceMaps(cwd, {});

    const files = await mapper.toFiles(
      coverage(pathToFileURL(join(cwd, 'src/app.mjs')).href),
    );
    expect(files.map((f) => f.file)).toEqual(['src/app.mjs']);
  });

  it('accepts one the project listed, and reports it', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const mapper = withSourceMaps(cwd, {
      buildDirs: [{ urlPrefix: 'http://localhost:5173/', dir: 'dist' }],
      allowUnmappable: ['https://cdn.example.com/**'],
    });

    // The accepted script must not take the rest of the entry down with it.
    const files = await mapper.toFiles(
      coverage(
        'https://cdn.example.com/widget.js',
        'http://localhost:5173/assets/app.js',
      ),
    );
    expect(files.map((f) => f.file)).toEqual(['src/app.mjs']);
    expect(mapper.takeAllowedUnmappable()).toEqual(['https://cdn.example.com/widget.js']);
  });

  it('hands each unit its own accepted scripts rather than only the last', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const mapper = withSourceMaps(cwd, {
      allowUnmappable: ['https://cdn.example.com/**'],
    });

    await mapper.toFiles(coverage('https://cdn.example.com/a.js'));
    expect(mapper.takeAllowedUnmappable()).toEqual(['https://cdn.example.com/a.js']);
    await mapper.toFiles(coverage('https://cdn.example.com/b.js'));
    expect(mapper.takeAllowedUnmappable()).toEqual(['https://cdn.example.com/b.js']);
    expect(mapper.takeAllowedUnmappable()).toEqual([]);
  });

  it('leaves the runtime’s own scripts alone', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const mapper = new V8FileMapper({ cwd, config });

    const files = await mapper.toFiles(
      coverage('node:internal/modules/esm/loader', 'evalmachine.<anonymous>'),
    );
    expect(files).toEqual([]);
  });
});
