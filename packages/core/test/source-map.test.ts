import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
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

function mapJson(sources: string[]): string {
  return JSON.stringify({ version: 3, file: 'app.js', sources, names: [], mappings: '' });
}

/** A repo whose `src/app.mjs` was built into `dist/assets/app.js`. */
function fixture(
  sources: string[],
  comment = '//# sourceMappingURL=app.js.map\n',
): string {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-sourcemap-'));
  dirs.push(cwd);
  write(cwd, 'src/app.mjs', APP);
  write(cwd, 'dist/assets/app.js', APP + comment);
  write(cwd, 'dist/assets/app.js.map', mapJson(sources));
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
    });
  });

  it('drops sources the repository does not hold', async () => {
    const cwd = fixture(['../../src/app.mjs', '/elsewhere/vendor.js']);
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toEqual({
      kind: 'mapped',
      sources: ['src/app.mjs'],
    });
  });

  it('reports a script with no map as unmapped rather than as covering nothing', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    rmSync(join(cwd, 'dist/assets/app.js.map'));
    write(cwd, 'dist/assets/app.js', APP);
    const resolver = new SourceMapResolver({ cwd });
    const url = pathToFileURL(join(cwd, 'dist/assets/app.js')).href;

    expect(await resolver.resolve({ url })).toEqual({ kind: 'unmapped' });
  });

  it('uses the script text the observation carried, without going back for it', async () => {
    // Browser coverage hands over the script it profiled, which is the only copy
    // a recorder gets when the page built it in memory.
    const cwd = fixture(['../../src/app.mjs']);
    const inline = `data:application/json;base64,${Buffer.from(mapJson(['src/app.mjs'])).toString('base64')}`;
    const resolver = new SourceMapResolver({ cwd, http: false });

    expect(
      await resolver.resolve({
        url: 'http://localhost:5173/assets/index-abc.js',
        source: `${APP}//# sourceMappingURL=${inline}\n`,
      }),
    ).toEqual({ kind: 'mapped', sources: ['src/app.mjs'] });
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
    ).toEqual({ kind: 'mapped', sources: ['src/app.mjs'] });
  });

  it('will not let a served path walk out of the directory it was mapped onto', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    write(cwd, 'secret.js', `${APP}//# sourceMappingURL=data:application/json,{}\n`);
    const resolver = new SourceMapResolver({
      cwd,
      buildDirs: [{ urlPrefix: 'http://localhost:5173/', dir: 'dist' }],
      http: false,
    });

    expect(await resolver.resolve({ url: 'http://localhost:5173/../secret.js' })).toEqual(
      { kind: 'unmapped' },
    );
  });

  it('fetches the script and its map over HTTP when they are not on disk', async () => {
    // What a browser recorder has: a URL, a dev server, and nothing local that
    // corresponds to it. Sources named from the server root are looked for at
    // the repository root, which is the shape a dev server publishes.
    const cwd = fixture(['/src/app.mjs']);
    const base = await serve(join(cwd, 'dist'));
    const resolver = new SourceMapResolver({ cwd });

    expect(await resolver.resolve({ url: `${base}assets/app.js` })).toEqual({
      kind: 'mapped',
      sources: ['src/app.mjs'],
    });
  }, 20_000);

  it('does not reach the network when HTTP loading is turned off', async () => {
    const cwd = fixture(['/src/app.mjs']);
    const base = await serve(join(cwd, 'dist'));
    const resolver = new SourceMapResolver({ cwd, http: false });

    expect(await resolver.resolve({ url: `${base}assets/app.js` })).toEqual({
      kind: 'unmapped',
    });
  }, 20_000);
});

describe('mapping coverage for scripts a runner only names by URL', () => {
  const config = resolveConfig({ sourceGlobs: ['src/**'] });
  const coverage = (url: string): RawCoverage => ({
    scripts: [
      { url, functions: [{ ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }] },
    ],
  });

  it('records the sources behind a served bundle', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const mapper = new V8FileMapper({
      cwd,
      config: {
        ...config,
        sourceMaps: {
          buildDirs: [{ urlPrefix: 'http://localhost:5173/', dir: 'dist' }],
          http: false,
          allowUnmappable: [],
        },
      },
    });

    const files = await mapper.toFiles(coverage('http://localhost:5173/assets/app.js'));
    expect(files.map((f) => f.file)).toEqual(['src/app.mjs']);
  });

  it('fails naming the script when there is no way back to its sources', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const mapper = new V8FileMapper({
      cwd,
      config: {
        ...config,
        sourceMaps: { buildDirs: [], http: false, allowUnmappable: [] },
      },
    });

    await expect(
      mapper.toFiles(coverage('http://localhost:5173/assets/app.js')),
    ).rejects.toThrow(UnmappableScriptError);
    await expect(
      mapper.toFiles(coverage('http://localhost:5173/assets/app.js')),
    ).rejects.toThrow(/http:\/\/localhost:5173\/assets\/app\.js/);
  });

  it('accepts one the project listed, and reports it', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const mapper = new V8FileMapper({
      cwd,
      config: {
        ...config,
        sourceMaps: {
          buildDirs: [],
          http: false,
          allowUnmappable: ['https://cdn.example.com/**'],
        },
      },
    });

    const files = await mapper.toFiles(coverage('https://cdn.example.com/widget.js'));
    expect(files).toEqual([]);
    expect(mapper.allowedUnmappable()).toEqual(['https://cdn.example.com/widget.js']);
  });

  it('leaves the runtime’s own scripts alone', async () => {
    const cwd = fixture(['../../src/app.mjs']);
    const mapper = new V8FileMapper({ cwd, config });

    const files = await mapper.toFiles({
      scripts: [
        ...coverage('node:internal/modules/esm/loader').scripts,
        ...coverage('evalmachine.<anonymous>').scripts,
      ],
    });
    expect(files).toEqual([]);
  });
});
