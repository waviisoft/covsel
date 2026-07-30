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
 * The rule this file is built around: **a source is either located or reported,
 * never guessed at**. A map names its sources relative to where the map itself
 * lives, so a map read from disk resolves them exactly. One fetched over HTTP
 * has no such anchor, and "strip the `../` and hope" would credit a same-named
 * file the test never executed — which loses the change to the file it did
 * execute. Anything that cannot be pinned to a file comes back as unresolved for
 * the caller to fail on, because a source silently missing from an entry is the
 * hole this whole mechanism exists to close.
 *
 * Only the `sources` list is read. Projecting the executed ranges through the
 * mappings is separate work; until it lands a mapped script credits every source
 * it was built from, which over-selects rather than under-selects.
 */

/** The parts of a source map covsel reads. */
export interface RawSourceMap {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources?: (string | null)[];
  /** Each source's text as it was at build time, when the build published it. */
  sourcesContent?: (string | null)[];
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
 * What resolving a script found.
 *
 * `mapped` carries two lists, and the difference between them is the whole
 * point. `sources` are original sources located in this repository. `unresolved`
 * are sources the map named that could be repo files but could not be pinned to
 * one — a path that does not exist where the map says, or a guess nothing
 * confirmed. Sources that are definitely not this repository's (a dependency's
 * absolute build path, a bundler's virtual module) appear in neither: they are
 * not missing coverage, they are not ours.
 *
 * `unmapped` means the build declared nothing at all, which is not the same as
 * declaring sources none of which are here.
 */
export type ResolvedScript =
  | { kind: 'mapped'; sources: string[]; unresolved: string[] }
  | { kind: 'unmapped'; reason: string };

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
 * A `sourceMappingURL` comment, which must end its line. Requiring that keeps a
 * `sourceMappingURL` mentioned inside a string literal from being read as the
 * script's own, while still finding the one a minifier appended to the last line
 * of code rather than putting on a line of its own.
 */
const SOURCE_MAPPING_URL =
  /(?:^|[\s;})])(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=([^\s'"*]+)[ \t]*(?:\*\/)?[ \t]*$/gm;

/** The last `sourceMappingURL` a script declares, which is the one that wins. */
export function readSourceMappingURL(text: string): string | undefined {
  let found: string | undefined;
  SOURCE_MAPPING_URL.lastIndex = 0;
  for (const match of text.matchAll(SOURCE_MAPPING_URL)) found = match[1];
  return found;
}

/**
 * Parse a source map, returning undefined for anything that is not one. A JSON
 * object is not enough: a dev server answering an SPA fallback with `{}` and a
 * 200, or an unrelated `.map` from another tool, would otherwise be read as a
 * build that declared no sources.
 */
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
  const map = parsed as RawSourceMap;
  if (!Array.isArray(map.sources) && !Array.isArray(map.sections)) return undefined;
  return map;
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

/** One source a map names, with the build-time text when the map carried it. */
export interface NamedSource {
  path: string;
  content?: string;
}

/** Every source a map names, following the sections of an index map. */
export function sourceMapSources(map: RawSourceMap): string[] {
  return namedSources(map).map((s) => s.path);
}

/**
 * A map's own sources, positionally, with `sourceRoot` applied. Unlike
 * `namedSources` this keeps the array's shape: entry `i` is what a mapping
 * segment's source index `i` refers to, and an entry a map left null or empty is
 * `undefined` rather than dropped. Sections are not followed, since their
 * segments index their own section's sources rather than this array.
 */
export function indexedSources(map: RawSourceMap): (string | undefined)[] {
  return (map.sources ?? []).map((source) =>
    typeof source === 'string' && source !== ''
      ? prefixWith(map.sourceRoot, source)
      : undefined,
  );
}

/** Every source a map names, paired with its published content. */
export function namedSources(map: RawSourceMap): NamedSource[] {
  const out: NamedSource[] = [];
  const sources = map.sources ?? [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (typeof source !== 'string' || source === '') continue;
    const content = map.sourcesContent?.[i];
    out.push({
      path: prefixWith(map.sourceRoot, source),
      ...(typeof content === 'string' ? { content } : {}),
    });
  }
  for (const section of map.sections ?? []) {
    if (section.map) out.push(...namedSources(section.map));
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

/** A scheme-carrying source whose path is written relative to the build root. */
const SCHEME_RELATIVE_PATH = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*\/\.{1,2}\//;

/**
 * True when a source names a path at all. Bundlers list synthetic modules
 * alongside real files — `vite/preload-helper`, `\0commonjsHelpers.js`,
 * `webpack://app/webpack/bootstrap` — and those are not files anyone can
 * change, so a missing one is not missing coverage. webpack writes its real
 * inputs with the `/./` that those lack, which is what tells them apart.
 */
function looksLikePath(source: string): boolean {
  if (source.startsWith('\0')) return false;
  if (HAS_SCHEME.test(source)) return SCHEME_RELATIVE_PATH.test(source);
  return (
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('/') ||
    isAbsolute(source)
  );
}

/** Strip the leading `../` and `./` segments of a relative path. */
function withoutLeadingDots(path: string): string {
  return path.replace(/^(?:\.{1,2}\/)+/, '');
}

/** Resolve a URL against a base, or undefined when it is not one. */
function resolveAgainst(base: string, ref: string): string | undefined {
  try {
    return new URL(ref, base).href;
  } catch {
    return undefined;
  }
}

/** The origin of an http(s) URL, or undefined for anything else. */
function httpOrigin(url: string): string | undefined {
  if (!/^https?:\/\//.test(url)) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** How one of a map's sources turned out. */
type SourceOutcome =
  { kind: 'located'; rel: string } | { kind: 'foreign' } | { kind: 'unresolved' };

/** Ten seconds is long for a dev server and short enough to not hang a recording. */
const FETCH_TIMEOUT_MS = 10_000;
/** Bundles are large; a response beyond this is not one covsel needs to read. */
const MAX_FETCH_BYTES = 64 * 1024 * 1024;

/**
 * Resolves the scripts a recorder saw to the original sources behind them.
 * Instances cache what they resolve, so a bundle shared by every test in a suite
 * is read once.
 */
export class SourceMapResolver {
  private readonly cwd: string;
  private readonly buildDirs: readonly BuildDirMapping[];
  private readonly http: boolean;
  private readonly fetchText: (url: string) => Promise<string | undefined>;
  /**
   * Resolutions by script URL. Only the answer is kept — holding every script's
   * text would grow with the size of the build.
   */
  private readonly resolved = new Map<string, ResolvedScript>();

  constructor(init: SourceMapResolverInit) {
    this.cwd = init.cwd;
    this.buildDirs = (init.buildDirs ?? []).map((mapping) => ({
      // Match at a path boundary, so `http://host:5173/` cannot claim the assets
      // of `http://host:51730/`, nor prefix `/app` those of `/apple.js`.
      urlPrefix: mapping.urlPrefix.endsWith('/')
        ? mapping.urlPrefix
        : `${mapping.urlPrefix}/`,
      dir: mapping.dir,
    }));
    this.http = init.http ?? true;
    this.fetchText = init.fetchText ?? defaultFetchText;
  }

  /**
   * The original sources behind one executed script. `source` is used when the
   * observation carried the script's text; otherwise the text is read from disk,
   * from a configured build directory, or over HTTP.
   */
  async resolve(script: ScriptRef): Promise<ResolvedScript> {
    if (script.source === undefined) {
      const cached = this.resolved.get(script.url);
      if (cached !== undefined) return cached;
    }
    const result = await this.resolveUncached(script.url, script.source);
    if (script.source === undefined) this.resolved.set(script.url, result);
    return result;
  }

  private async resolveUncached(
    url: string,
    source: string | undefined,
  ): Promise<ResolvedScript> {
    // The query stays on for loading: a dev server's `?worker_file` or `?raw`
    // names a different resource, not a decoration on this one.
    const text = source ?? (await this.load(url));
    if (text === undefined && source === undefined) {
      return { kind: 'unmapped', reason: 'the script itself could not be read' };
    }

    let mapUrl: string | undefined;
    let map: RawSourceMap | undefined;
    const declared = text === undefined ? undefined : readSourceMappingURL(text);
    if (declared !== undefined) {
      if (declared.startsWith('data:')) {
        map = decodeDataSourceMap(declared);
        mapUrl = url;
      } else {
        mapUrl = resolveAgainst(url, declared);
        map = mapUrl === undefined ? undefined : await this.loadMap(url, mapUrl);
      }
    }
    // A build can emit the map and strip the comment pointing at it — Vite's
    // `sourcemap: 'hidden'` does exactly that, and it is common in production
    // builds. The conventional neighbour is the only thing left to go on. It is
    // trusted as far as any declared map is: a stale one beside a rebuilt script
    // is indistinguishable from a current one.
    if (map === undefined) {
      const neighbour = `${stripUrlQuery(url)}.map`;
      map = await this.loadMap(url, neighbour);
      if (map !== undefined) mapUrl = neighbour;
    }
    if (map === undefined) {
      return {
        kind: 'unmapped',
        reason:
          declared === undefined
            ? 'it declares no sourceMappingURL and no source map sits beside it'
            : `its sourceMappingURL (${declared.startsWith('data:') ? 'inline' : declared}) could not be read as a source map`,
      };
    }

    const sources: string[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();
    for (const named of namedSources(map)) {
      const outcome = this.locate(named, mapUrl ?? url);
      if (outcome.kind === 'foreign') continue;
      if (outcome.kind === 'unresolved') {
        if (!unresolved.includes(named.path)) unresolved.push(named.path);
        continue;
      }
      if (seen.has(outcome.rel)) continue;
      seen.add(outcome.rel);
      sources.push(outcome.rel);
    }
    return { kind: 'mapped', sources: sources.sort(), unresolved };
  }

  /**
   * Pin one of a map's sources to a file in this repository.
   *
   * A map read from disk — or through a build directory — anchors its relative
   * sources at its own location, and that resolution is exact: the file is there
   * or the map is stale. A map fetched over HTTP has no anchor, so the repo root
   * is the only thing to try, and a path that merely exists there is not
   * evidence. `sourcesContent` is: when the build published the source's text,
   * matching it against the candidate turns the guess into a check. Without that
   * confirmation the source is reported unresolved rather than credited to a
   * file that may have nothing to do with it.
   */
  private locate(named: NamedSource, mapUrl: string): SourceOutcome {
    const source = named.path;
    let insideRepo = false;
    for (const candidate of this.candidates(source, this.localPath(mapUrl))) {
      const rel = toRepoRelative(this.cwd, candidate.abs);
      if (rel === undefined) continue; // someone else's tree
      insideRepo = true;
      if (!existsSync(candidate.abs)) continue;
      // An anchored path is exact, so its content is not asked to vouch for it:
      // a source edited since the build is still that source. An unanchored one
      // is a guess, and only the published content can turn it into a fact.
      if (candidate.anchored) return { kind: 'located', rel };
      if (named.content !== undefined && this.holds(candidate.abs, named.content)) {
        return { kind: 'located', rel };
      }
    }
    // Nothing was found. If no candidate was even inside the repository, this
    // source is not ours to record. Otherwise it is missing coverage — unless it
    // never named a path at all, in which case it is one of the synthetic
    // modules bundlers list beside real files.
    if (!insideRepo) return { kind: 'foreign' };
    return looksLikePath(source) ? { kind: 'unresolved' } : { kind: 'foreign' };
  }

  /**
   * Where a source could be on disk. `anchored` marks a location derived from
   * where the map itself lives, which is exact; everything else is a guess that
   * has to be confirmed before it can be credited.
   */
  private *candidates(
    source: string,
    anchor: string | undefined,
  ): Generator<{ abs: string; anchored: boolean }> {
    if (source.startsWith('file://')) {
      try {
        yield { abs: fileURLToPath(stripUrlQuery(source)), anchored: true };
      } catch {
        /* not a path we can use */
      }
      return;
    }
    if (HAS_SCHEME.test(source)) {
      // `webpack://project/./src/a.ts` and friends: the authority names the
      // build or the package, not a host, so it may or may not be part of the
      // path. Try it both ways rather than discarding it.
      let parsed: URL;
      try {
        parsed = new URL(source);
      } catch {
        return;
      }
      const authority = `${parsed.username ? `${parsed.username}@` : ''}${parsed.host}`;
      yield { abs: resolve(this.cwd, `.${parsed.pathname}`), anchored: false };
      if (authority) {
        yield {
          abs: resolve(this.cwd, authority, `.${parsed.pathname}`),
          anchored: false,
        };
      }
      return;
    }
    if (anchor !== undefined) {
      yield {
        abs: isAbsolute(source) ? source : resolve(dirname(anchor), source),
        anchored: true,
      };
      return;
    }
    // Unanchored: the server root stands in for the repo root.
    yield {
      abs: isAbsolute(source)
        ? resolve(this.cwd, `.${source}`)
        : resolve(this.cwd, withoutLeadingDots(source)),
      anchored: false,
    };
  }

  /** True when the file on disk is the text the build published for a source. */
  private holds(abs: string, content: string): boolean {
    try {
      return readFileSync(abs, 'utf8') === content;
    } catch {
      return false;
    }
  }

  /** Load a source map by URL, on behalf of the script that named it. */
  private async loadMap(
    scriptUrl: string,
    mapUrl: string,
  ): Promise<RawSourceMap | undefined> {
    // A `sourceMappingURL` is content covsel did not write, and following one to
    // another host would turn recording into a request generator pointed
    // wherever a bundle says — including at whatever a CI runner can reach.
    const scriptOrigin = httpOrigin(scriptUrl);
    const target = httpOrigin(mapUrl);
    if (target !== undefined && target !== scriptOrigin) return undefined;
    const text = await this.load(mapUrl);
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

/**
 * Fetch a URL's text, treating any non-2xx, oversized, or failed response as
 * absent. Recording must not hang on a server that accepts the connection and
 * never answers, and must not follow a redirect somewhere else.
 */
async function defaultFetchText(url: string): Promise<string | undefined> {
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return undefined;
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_FETCH_BYTES) return undefined;
  const text = await res.text();
  return text.length > MAX_FETCH_BYTES ? undefined : text;
}
