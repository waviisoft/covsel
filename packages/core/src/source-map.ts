import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripUrlQuery, toRepoRelative } from './paths.js';

/**
 * Finding the original sources behind a script a runner executed.
 *
 * A bundled script is not the code anyone wrote, so coverage against it means
 * nothing until it is resolved back to the sources it was built from. That
 * resolution has four shapes in the wild, and a recorder meets all of them: a
 * `sourceMappingURL` comment naming a sidecar file, the same comment carrying
 * the whole map inline as a `data:` URI, a script the recorder only ever sees
 * over HTTP because a browser loaded it from a dev server, and a build whose
 * assets live in a directory the URL can be mapped onto.
 *
 * Only the `sources` list is read here. Projecting the executed ranges through
 * the mappings is separate work; until it lands a mapped script credits every
 * source it was built from, which over-selects rather than under-selects.
 */

/** The parts of a source map covsel reads. */
export interface RawSourceMap {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources?: (string | null)[];
  mappings?: string;
  /** Index maps carry their sections' maps instead of their own `sources`. */
  sections?: { map?: RawSourceMap }[];
}

/** A script a recorder observed executing, with its text when the tool had it. */
export interface ScriptRef {
  url: string;
  /** The script's text, when the observation carried it (browser coverage does). */
  source?: string;
}

/**
 * What resolving a script found: the repo-relative original sources behind it,
 * or nothing at all. `mapped` with an empty list is not the same as `unmapped` —
 * the first says the build declared its sources and none of them are in this
 * repository, the second says the build declared nothing.
 */
export type ResolvedScript = { kind: 'mapped'; sources: string[] } | { kind: 'unmapped' };

/** Where scripts a runner executed by URL can be found on disk. */
export interface BuildDirMapping {
  /** URL prefix the built assets are served under, e.g. `http://localhost:5173/`. */
  urlPrefix: string;
  /** Directory holding them, absolute or relative to the repo root. */
  dir: string;
}

export interface SourceMapResolverInit {
  cwd: string;
  buildDirs?: readonly BuildDirMapping[];
  /** Load scripts and maps over HTTP when they are not on disk (default true). */
  http?: boolean;
  /** Text loader for HTTP URLs; the default uses `fetch`. */
  fetchText?: (url: string) => Promise<string | undefined>;
}

/**
 * A comment on a line of its own, in either comment syntax. Requiring the line
 * keeps a `sourceMappingURL` mentioned inside a string literal from being read
 * as the script's own; every bundler emits it as a trailing comment.
 */
const SOURCE_MAPPING_URL =
  /^[ \t]*(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=([^\s'"*]+)[ \t]*(?:\*\/)?[ \t]*$/gm;

/** The last `sourceMappingURL` a script declares, which is the one that wins. */
export function readSourceMappingURL(text: string): string | undefined {
  let found: string | undefined;
  SOURCE_MAPPING_URL.lastIndex = 0;
  for (const match of text.matchAll(SOURCE_MAPPING_URL)) found = match[1];
  return found;
}

/** Parse a source map, returning undefined for anything that is not one. */
export function parseSourceMap(text: string): RawSourceMap | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as RawSourceMap;
}

/** Decode a `data:` source-map URI, base64 or percent-encoded. */
export function decodeDataSourceMap(url: string): RawSourceMap | undefined {
  if (!url.startsWith('data:')) return undefined;
  const comma = url.indexOf(',');
  if (comma === -1) return undefined;
  const meta = url.slice('data:'.length, comma).split(';');
  const payload = url.slice(comma + 1);
  try {
    return parseSourceMap(
      meta.includes('base64')
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload),
    );
  } catch {
    return undefined;
  }
}

/** Every source a map names, following the sections of an index map. */
export function sourceMapSources(map: RawSourceMap): string[] {
  const out: string[] = [];
  for (const source of map.sources ?? []) {
    if (typeof source === 'string' && source !== '')
      out.push(prefixWith(map.sourceRoot, source));
  }
  for (const section of map.sections ?? []) {
    if (section.map) out.push(...sourceMapSources(section.map));
  }
  return out;
}

/** Apply a map's `sourceRoot` to one of its sources, URL-join style. */
function prefixWith(sourceRoot: string | undefined, source: string): string {
  if (sourceRoot === undefined || sourceRoot === '') return source;
  if (isAbsolute(source) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source)) return source;
  return sourceRoot.endsWith('/') ? `${sourceRoot}${source}` : `${sourceRoot}/${source}`;
}

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** Strip the leading `../` and `./` segments of a relative path. */
function withoutLeadingDots(path: string): string {
  return path.replace(/^(?:\.{1,2}\/)+/, '');
}

/** Resolve a script URL against a base URL, or undefined when it is not one. */
function resolveAgainst(base: string, ref: string): string | undefined {
  try {
    return new URL(ref, base).href;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the scripts a recorder saw to the original sources behind them.
 * Instances cache what they load, so a bundle shared by every test in a suite is
 * read once.
 */
export class SourceMapResolver {
  private readonly cwd: string;
  private readonly buildDirs: readonly BuildDirMapping[];
  private readonly http: boolean;
  private readonly fetchText: (url: string) => Promise<string | undefined>;
  /**
   * Resolutions by script URL. A suite's tests share their bundles, so this is
   * the difference between reading a bundle once and reading it per test file.
   * Only the answer is kept — holding every script's text would grow with the
   * size of the build.
   */
  private readonly resolved = new Map<string, ResolvedScript>();

  constructor(init: SourceMapResolverInit) {
    this.cwd = init.cwd;
    this.buildDirs = init.buildDirs ?? [];
    this.http = init.http ?? true;
    this.fetchText = init.fetchText ?? defaultFetchText;
  }

  /**
   * The in-repo original sources behind one executed script. `source` is used
   * when the observation carried the script's text; otherwise the text is read
   * from disk, from a configured build directory, or over HTTP.
   */
  async resolve(script: ScriptRef): Promise<ResolvedScript> {
    const url = stripUrlQuery(script.url);
    if (script.source === undefined) {
      const cached = this.resolved.get(url);
      if (cached !== undefined) return cached;
    }
    const result = await this.resolveUncached(url, script.source);
    if (script.source === undefined) this.resolved.set(url, result);
    return result;
  }

  private async resolveUncached(
    url: string,
    source: string | undefined,
  ): Promise<ResolvedScript> {
    const text = source ?? (await this.load(url));

    let mapUrl: string | undefined;
    let map: RawSourceMap | undefined;
    const declared = text === undefined ? undefined : readSourceMappingURL(text);
    if (declared !== undefined) {
      if (declared.startsWith('data:')) {
        map = decodeDataSourceMap(declared);
        mapUrl = url;
      } else {
        mapUrl = resolveAgainst(url, declared);
        map = mapUrl === undefined ? undefined : await this.loadMap(mapUrl);
      }
    }
    // A build can emit the map and strip the comment pointing at it — Vite's
    // `sourcemap: 'hidden'` does exactly that, and it is common in production
    // builds. The conventional neighbour is the only thing left to go on.
    if (map === undefined) {
      mapUrl = `${url}.map`;
      map = await this.loadMap(mapUrl);
    }
    if (map === undefined) return { kind: 'unmapped' };

    const sources: string[] = [];
    const seen = new Set<string>();
    for (const source of sourceMapSources(map)) {
      const rel = this.repoRelativeSource(source, mapUrl ?? url);
      if (rel === undefined || seen.has(rel)) continue;
      seen.add(rel);
      sources.push(rel);
    }
    return { kind: 'mapped', sources: sources.sort() };
  }

  /** One of a map's sources as a repo-relative path, when it is one. */
  private repoRelativeSource(source: string, mapUrl: string): string | undefined {
    for (const abs of this.candidatePaths(source, mapUrl)) {
      const rel = toRepoRelative(this.cwd, abs);
      if (rel !== undefined && existsSync(abs)) return rel;
    }
    return undefined;
  }

  /**
   * Where one of a map's sources could be on disk, best guess first. A map that
   * came from disk anchors its relative sources at its own directory, which is
   * exact. One fetched over HTTP has no such anchor unless a build directory was
   * configured for it, so the repo root stands in — a served path and the
   * repo-relative path of its source are usually the same shape.
   */
  private *candidatePaths(source: string, mapUrl: string): Generator<string> {
    if (source.startsWith('file://')) {
      try {
        yield fileURLToPath(stripUrlQuery(source));
      } catch {
        /* not a path we can use */
      }
      return;
    }
    if (HAS_SCHEME.test(source)) {
      // `webpack://project/./src/a.ts` and friends: the authority names the
      // build, not a host, so only the path is meaningful.
      const path = resolveAgainst('file:///', source);
      const pathname = path === undefined ? undefined : new URL(path).pathname;
      if (pathname !== undefined) yield resolve(this.cwd, `.${pathname}`);
      return;
    }
    const anchor = this.localPath(mapUrl);
    if (isAbsolute(source)) {
      // Served maps name sources from the server root, which reads as absolute.
      if (anchor === undefined) yield resolve(this.cwd, `.${source}`);
      yield source;
      return;
    }
    if (anchor !== undefined) yield resolve(dirname(anchor), source);
    else yield resolve(this.cwd, withoutLeadingDots(source));
  }

  /** Load a source map by URL. */
  private async loadMap(url: string): Promise<RawSourceMap | undefined> {
    const text = await this.load(url);
    return text === undefined ? undefined : parseSourceMap(text);
  }

  /** Text of a URL, from disk, a configured build directory, or over HTTP. */
  private async load(url: string): Promise<string | undefined> {
    const local = this.localPath(url);
    if (local !== undefined) {
      try {
        return readFileSync(local, 'utf8');
      } catch {
        return undefined;
      }
    }
    if (!this.http || !/^https?:\/\//.test(url)) return undefined;
    try {
      return await this.fetchText(url);
    } catch {
      return undefined;
    }
  }

  /** The file on disk a URL names, through a build directory when it needs one. */
  private localPath(url: string): string | undefined {
    if (url.startsWith('file://')) {
      try {
        return fileURLToPath(stripUrlQuery(url));
      } catch {
        return undefined;
      }
    }
    const plain = stripUrlQuery(url);
    for (const { urlPrefix, dir } of this.buildDirs) {
      if (!plain.startsWith(urlPrefix)) continue;
      const root = resolve(this.cwd, dir);
      let rest = plain.slice(urlPrefix.length).replace(/^\/+/, '');
      try {
        rest = decodeURIComponent(rest);
      } catch {
        /* keep it as written */
      }
      const abs = resolve(root, rest);
      // A served path is attacker-shaped input as far as this is concerned: it
      // may not walk out of the directory it was mapped onto.
      if (abs !== root && !abs.startsWith(root + sep)) continue;
      return abs;
    }
    return undefined;
  }
}

/** Fetch a URL's text, treating any non-2xx or transport failure as absent. */
async function defaultFetchText(url: string): Promise<string | undefined> {
  const res = await fetch(url);
  if (!res.ok) return undefined;
  return await res.text();
}
