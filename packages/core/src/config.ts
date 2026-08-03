import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type Granularity, GRANULARITIES, isGranularity } from './schema.js';
import type { BuildDirMapping } from './source-map.js';

/** How a recording resolves bundled scripts back to the sources behind them. */
export interface SourceMapConfig {
  /**
   * Where scripts a runner executed by URL can be found on disk, so a build's
   * assets can be read without going back to the server that served them.
   */
  buildDirs: BuildDirMapping[];
  /** Load scripts and their maps over HTTP when they are not on disk. */
  http: boolean;
  /**
   * Scripts whose unmappability is accepted rather than fatal, matched against
   * the script's repo-relative path or, for anything outside the repo, its URL.
   *
   * An executed script that cannot be resolved to original sources normally
   * fails the recording, because a map entry that credits nothing is read as a
   * test that covers nothing. Some scripts genuinely never will be mappable — a
   * third-party widget on the page under test — and failing every recording over
   * one is not workable. Each entry here is a hole in the recording that the
   * project has decided to accept, so recording names the scripts it let through
   * every time it lets one through.
   */
  allowUnmappable: string[];
}

/**
 * User-facing configuration. Every field has a zero-config default, so a
 * project needs no config file to get sensible zero-config selection.
 */
export interface CovselConfig {
  /**
   * The adapter this project records with, by the same short name `--adapter`
   * takes. Unset means the consumer's default, which is why this is the one
   * field with no default here: covsel ships no adapters, so core cannot name
   * one that is certain to be installed. `covsel init` writes it so the choice
   * is made once rather than repeated on every invocation, and `--adapter`
   * still wins over it.
   */
  adapter?: string;
  /** Globs identifying test files. */
  testGlobs: string[];
  /** Globs identifying source files whose changes can affect tests. */
  sourceGlobs: string[];
  /** Test files that must always run regardless of the diff. */
  alwaysRun: string[];
  /** Files whose change invalidates the map and forces a full run. */
  sentinels: string[];
  /**
   * Recording granularity: 'block' (function-level) narrows selection further.
   * The same set the map may name, so a project cannot ask for a recording
   * covsel could not store.
   */
  granularity: Granularity;
  /** How bundled scripts are resolved back to original sources. */
  sourceMaps: SourceMapConfig;
  /** Where the local map is stored. */
  store: {
    dir: string;
    /**
     * Where `covsel publish` keeps maps by commit, and `covsel fetch` looks for
     * one this checkout can measure change from. Relative to {@link store.dir}
     * unless absolute, so caching the store directory carries the archive with
     * it.
     */
    archiveDir: string;
  };
}

/**
 * Configuration as a project writes it: every field optional, and the grouped
 * ones fillable a field at a time.
 */
export interface CovselConfigInput extends Partial<
  Omit<CovselConfig, 'sourceMaps' | 'store'>
> {
  sourceMaps?: Partial<SourceMapConfig>;
  store?: Partial<CovselConfig['store']>;
}

export const DEFAULT_CONFIG: CovselConfig = {
  testGlobs: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  sourceGlobs: ['**/*'],
  alwaysRun: [],
  sentinels: [
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'tsconfig*.json',
  ],
  granularity: 'block',
  sourceMaps: { buildDirs: [], http: true, allowUnmappable: [] },
  store: { dir: '.covsel', archiveDir: 'archive' },
};

/**
 * The granularity a project asked for, the default when it asked for none, or a
 * failure naming what covsel records at.
 *
 * A config file is not type-checked, so this is where an unimplemented value
 * arrives. Neither fallback is honest about it: resolving to `file` records at a
 * granularity the project never named, and resolving to `block` ignores the ask
 * entirely -- both silently, on every run thereafter. Failing at load is the one
 * outcome the project can see, and it cannot cost a test: nothing has been
 * selected yet, so nothing is skipped.
 *
 * An explicit `null` is not that case. It reads as "unchosen" everywhere else in
 * this file, because every other field takes the default for it, and a config
 * generator emitting one is not asking covsel for something it cannot do.
 */
function resolveGranularity(value: unknown): Granularity {
  if (value === undefined || value === null) return DEFAULT_CONFIG.granularity;
  if (isGranularity(value)) return value;
  throw new Error(
    `covsel config: granularity ${JSON.stringify(value)} is not supported ` +
      `-- use one of ${GRANULARITIES.join(', ')}`,
  );
}

/**
 * Merge a partial config over the defaults (arrays replace; the grouped fields
 * merge field by field).
 */
export function resolveConfig(partial?: CovselConfigInput): CovselConfig {
  return {
    ...(partial?.adapter !== undefined ? { adapter: partial.adapter } : {}),
    testGlobs: partial?.testGlobs ?? DEFAULT_CONFIG.testGlobs,
    sourceGlobs: partial?.sourceGlobs ?? DEFAULT_CONFIG.sourceGlobs,
    alwaysRun: partial?.alwaysRun ?? DEFAULT_CONFIG.alwaysRun,
    sentinels: partial?.sentinels ?? DEFAULT_CONFIG.sentinels,
    granularity: resolveGranularity(partial?.granularity),
    sourceMaps: { ...DEFAULT_CONFIG.sourceMaps, ...partial?.sourceMaps },
    store: { ...DEFAULT_CONFIG.store, ...partial?.store },
  };
}

/**
 * Configuration fields whose change cannot leave a recorded map meaning
 * something other than what selection reads out of it.
 *
 * A denylist rather than an allowlist, and deliberately so: everything else is
 * compared, so a field added to the config later is compared from the day it
 * exists rather than admitted as inert by an allowlist nobody remembered to
 * extend. Adding a name here is a claim that has to be argued, and only one
 * field survives the argument: `store` says where the map is kept, not what it
 * says. Point it somewhere else and a different map is read -- or none, which
 * falls open on its own.
 *
 * `alwaysRun` and `sentinels` are not here, though they are read from the
 * configuration in force and so cannot leave the map meaning one thing while
 * selection reads another. The diff that *removes* one is the case: a commit
 * that drops a file from `sentinels` and edits that same file would, if this
 * were inert, take effect immediately and select nothing for a file nothing can
 * attribute. They change rarely, so comparing them costs almost nothing and
 * keeps the transition covered.
 */
const INERT_CONFIG_FIELDS = ['store'] as const;

/**
 * A map's record of the configuration it was recorded under: one digest per
 * compared field, keyed by field name.
 *
 * Digests rather than values, for two reasons. A map is published to an archive
 * other machines fetch, and `sourceMaps.buildDirs` holds paths that can be
 * absolute and URL prefixes that can name an internal host -- none of which a
 * map has ever carried before, and none of which this feature needs. And the
 * comparison only ever asks whether a field moved, so a digest answers it in
 * full while naming the field it belongs to.
 */
export type ConfigDigests = Record<string, string>;

/**
 * The digest of a value covsel cannot serialise faithfully, which therefore
 * never compares equal to anything, including itself.
 *
 * A config file is `.js` and is never type-checked, so a field can hold a
 * `RegExp`, a `Map`, a class instance or a function. Enumerating own properties
 * renders every one of those as `{}`, which would make two different values
 * agree -- and agreement is the answer that narrows a selection. Refusing to
 * represent them means the field reads as changed on every run instead, which
 * costs a full run and cannot cost a test.
 */
const OPAQUE = 'opaque';

/**
 * Serialise a value so two configs compare by content: object keys sort, array
 * order is kept because it is meaningful in every field that holds one, and an
 * explicit `undefined` reads as the absence a JSON round-trip turns it into.
 *
 * Returns `undefined` for anything it cannot represent faithfully, which the
 * caller must treat as changed rather than as equal.
 */
function canonical(value: unknown): string | undefined {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const items = value.map(canonical);
    return items.some((item) => item === undefined) ? undefined : `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    // Own enumerable properties describe a plain object and nothing else: a Map
    // has none, a RegExp has none, a Date has none, and each would render as the
    // same empty object as the next.
    if (Object.prototype.toString.call(value) !== '[object Object]') return undefined;
    const fields: string[] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))) {
      const rendered = canonical(item);
      if (rendered === undefined) return undefined;
      fields.push(`${JSON.stringify(key)}:${rendered}`);
    }
    return `{${fields.join(',')}}`;
  }
  // Everything left is a primitive, and `JSON.stringify` is typed `string` while
  // returning `undefined` for a function or a symbol -- which is exactly the
  // unrepresentable case, so it needs no separate test.
  return JSON.stringify(value) as string | undefined;
}

/** The digest of one field's value, or the marker for one covsel cannot read. */
function digest(value: unknown): string {
  const rendered = canonical(value);
  if (rendered === undefined) return OPAQUE;
  return `sha256:${createHash('sha256').update(rendered).digest('hex').slice(0, 32)}`;
}

/** What a map records about the configuration it was recorded under. */
export function recordedConfig(config: CovselConfig): ConfigDigests {
  const values: Record<string, unknown> = { ...config };
  for (const field of INERT_CONFIG_FIELDS) delete values[field];
  const digests: ConfigDigests = {};
  for (const [field, value] of Object.entries(values)) digests[field] = digest(value);
  return digests;
}

/**
 * A map's recorded configuration, when it has one covsel can compare against.
 *
 * A map carrying a `config` that is not a record of digests -- `null`, a
 * number, a hand-edited fragment -- is one whose recording covsel cannot
 * interrogate, which is the same position as a map that recorded none at all:
 * the caller falls back to the check that reads the diff. Answering with a
 * throw instead would turn `affected`, `status` and `merge` into a stack trace
 * over a field whose whole purpose is to make a run safer.
 */
export function recordedConfigOf(map: { config?: unknown }): ConfigDigests | undefined {
  const recorded = map.config;
  if (typeof recorded !== 'object' || recorded === null || Array.isArray(recorded)) {
    return undefined;
  }
  return recorded as ConfigDigests;
}

/**
 * Fields whose values differ between the configuration a map was recorded under
 * and the one in force now, sorted.
 *
 * Empty means the map means what it meant, whatever the config file's bytes did
 * in between -- a reworded comment, a reformatted array, a key that moved. The
 * question a full run turns on is whether a value covsel reads has moved, and
 * this is that question asked directly instead of inferred from a diff.
 *
 * A field covsel could not represent on either side counts as changed, since
 * two values it cannot read are not two values it knows to be the same.
 */
export function changedConfigFields(
  before: ConfigDigests,
  after: ConfigDigests,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => {
      const from = before[name];
      const to = after[name];
      return from === OPAQUE || to === OPAQUE || from !== to;
    })
    .sort();
}

/** Config file names looked up, in priority order. */
export const CONFIG_FILES = [
  'covsel.json',
  'covsel.config.js',
  'covsel.config.mjs',
  'covsel.config.cjs',
] as const;

/** The config file `loadConfig` would read from `cwd`, if any exists. */
export function findConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILES) {
    const path = join(cwd, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Read the user's config file from `cwd` without applying defaults, so callers
 * can tell which fields were actually set. Returns an empty object when no
 * config file is present. JSON is parsed directly; `.js` / `.mjs` / `.cjs` are
 * imported and their default (or module) export is used.
 */
export async function loadRawConfig(cwd: string): Promise<CovselConfigInput> {
  for (const name of CONFIG_FILES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    if (name.endsWith('.json')) {
      return JSON.parse(readFileSync(path, 'utf8')) as CovselConfigInput;
    }
    const mod = (await import(pathToFileURL(path).href)) as {
      default?: CovselConfigInput;
    } & CovselConfigInput;
    return mod.default ?? mod;
  }
  return {};
}

/**
 * Load configuration from `cwd`, or fall back to defaults when no config file
 * is present.
 */
export async function loadConfig(cwd: string): Promise<CovselConfig> {
  return resolveConfig(await loadRawConfig(cwd));
}
