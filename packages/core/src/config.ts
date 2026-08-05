import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { INSTALL_CONFIG_NAMES, LOCKFILE_NAMES } from './lockfiles.js';
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
  /**
   * Repo-relative globs the project asserts its recording can observe execution
   * within, for a recorder that cannot work this out for itself.
   *
   * Most recorders can. One watching a Node process tree covsel started sees
   * every script that tree loads, wherever it lives, so it declares everything
   * and needs nothing here. A recorder watching a *browser* sees only what the
   * build shipped to it, and which repo paths those are depends on the project's
   * build layout and where its server lives — neither of which the adapter can
   * infer, and both of which the project knows.
   *
   * This is a claim about recall, and it is read exactly as written: declare a
   * path only when, had code there run, the recording would have seen it. Every
   * path outside falls open on change, because the map's silence about it means
   * nothing. Under-claiming costs CI minutes; over-claiming skips tests, which is
   * why no adapter defaults it and one that needs it refuses to record without it.
   *
   * It is a ceiling, not a filter: it does not decide what gets recorded, only
   * what the resulting map claims it was in a position to see.
   */
  observes?: string[];
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
  // What is installed, how it is laid out, and how it is compiled. The install
  // configs are here for the same reason the lockfiles are: they decide what a
  // source's imports resolve to, and nothing covsel records moves when they do.
  sentinels: [
    'package.json',
    ...LOCKFILE_NAMES,
    ...INSTALL_CONFIG_NAMES,
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
    // Left absent when unset rather than defaulted, because both defaults are
    // wrong: `**` is the over-claim that skips tests, and `[]` would make every
    // change a full run for every recorder that knows its own reach. Absent is
    // the recorder's cue to use its own declaration, or to refuse.
    ...(partial?.observes !== undefined ? { observes: partial.observes } : {}),
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
 * extend. Adding a name here is a claim that has to be argued, and the four
 * below are:
 *
 *  - `alwaysRun` and `sentinels` are read from the configuration in force at
 *    selection time and applied to the diff in front of it. A change to either
 *    takes effect on the next run whatever the map says, so it cannot leave the
 *    map meaning one thing while selection reads another.
 *  - `store` says where the map is kept, not what it says. Point it somewhere
 *    else and a different map is read -- or none, which falls open on its own.
 *  - `adapter` names the recorder. Every consequence its identity has for
 *    selection -- what it was able to observe, what granularity it recorded at
 *    -- is written into the map by the recording itself, so the name adds
 *    nothing selection reads. It is also the one field a CLI flag overrides,
 *    and comparing it would make `--adapter` on one invocation and not the next
 *    look like a configuration change.
 */
const INERT_CONFIG_FIELDS = ['adapter', 'alwaysRun', 'sentinels', 'store'] as const;

/**
 * The configuration a map is recorded under, as the map stores it: every
 * resolved field whose value shapes what the map means.
 */
export type RecordedConfig = Omit<CovselConfig, (typeof INERT_CONFIG_FIELDS)[number]>;

/** The part of a resolved config a map records, for a later run to compare against. */
export function recordedConfig(config: CovselConfig): RecordedConfig {
  const view: Record<string, unknown> = { ...config };
  for (const field of INERT_CONFIG_FIELDS) delete view[field];
  return view as RecordedConfig;
}

/**
 * Serialise a value so two configs compare by content: object keys sort, array
 * order is kept because it is meaningful in every field that holds one, and an
 * explicit `undefined` reads as the absence a JSON round-trip turns it into.
 */
function canonical(value: unknown): string {
  if (value === undefined) return 'absent';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Fields whose values differ between the configuration a map was recorded under
 * and the one in force now, sorted.
 *
 * Empty means the map means what it meant, whatever the config file's bytes did
 * in between -- a reworded comment, a reformatted array, a key that moved. The
 * question a full run turns on is whether a value covsel reads has moved, and
 * this is that question asked directly instead of inferred from a diff.
 */
export function changedConfigFields(
  before: RecordedConfig,
  after: RecordedConfig,
): string[] {
  const from = before as Record<string, unknown>;
  const to = after as Record<string, unknown>;
  const names = new Set([...Object.keys(from), ...Object.keys(to)]);
  return [...names]
    .filter((name) => canonical(from[name]) !== canonical(to[name]))
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
