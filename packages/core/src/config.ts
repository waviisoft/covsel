import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LOCKFILE_NAMES } from './lockfiles.js';
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
  sentinels: ['package.json', ...LOCKFILE_NAMES, 'tsconfig*.json'],
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
