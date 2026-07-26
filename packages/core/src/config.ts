import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * User-facing configuration. Every field has a zero-config default, so a
 * project needs no config file to get sensible zero-config selection.
 */
export interface CovselConfig {
  /** Globs identifying test files. */
  testGlobs: string[];
  /** Globs identifying source files whose changes can affect tests. */
  sourceGlobs: string[];
  /** Test files that must always run regardless of the diff. */
  alwaysRun: string[];
  /** Files whose change invalidates the map and forces a full run. */
  sentinels: string[];
  /** Recording granularity: 'block' (function-level) narrows selection further. */
  granularity: 'block' | 'file';
  /** Where the local map is stored. */
  store: { dir: string };
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
  store: { dir: '.covsel' },
};

/** Merge a partial config over the defaults (arrays replace; store merges). */
export function resolveConfig(partial?: Partial<CovselConfig>): CovselConfig {
  return {
    testGlobs: partial?.testGlobs ?? DEFAULT_CONFIG.testGlobs,
    sourceGlobs: partial?.sourceGlobs ?? DEFAULT_CONFIG.sourceGlobs,
    alwaysRun: partial?.alwaysRun ?? DEFAULT_CONFIG.alwaysRun,
    sentinels: partial?.sentinels ?? DEFAULT_CONFIG.sentinels,
    granularity: partial?.granularity ?? DEFAULT_CONFIG.granularity,
    store: { ...DEFAULT_CONFIG.store, ...partial?.store },
  };
}

/** Config file names looked up, in priority order. */
const CONFIG_FILES = [
  '.covsel.json',
  'covsel.config.js',
  'covsel.config.mjs',
  'covsel.config.cjs',
] as const;

/**
 * Read the user's config file from `cwd` without applying defaults, so callers
 * can tell which fields were actually set. Returns an empty object when no
 * config file is present. JSON is parsed directly; `.js` / `.mjs` / `.cjs` are
 * imported and their default (or module) export is used.
 */
export async function loadRawConfig(cwd: string): Promise<Partial<CovselConfig>> {
  for (const name of CONFIG_FILES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    if (name.endsWith('.json')) {
      return JSON.parse(readFileSync(path, 'utf8')) as Partial<CovselConfig>;
    }
    const mod = (await import(pathToFileURL(path).href)) as {
      default?: Partial<CovselConfig>;
    } & Partial<CovselConfig>;
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
