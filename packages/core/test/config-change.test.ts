import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CovselConfig,
  createGenericRecorder,
  recordMap,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

import { git as runGit, write as writeFile } from './helpers/repo.js';

/**
 * A map is meaningful only under the configuration it was recorded with, which
 * is a statement about the configuration's *values*. covsel used to read it as a
 * statement about the file: any diff touching `covsel.config.js` forced a full
 * run, so rewording a comment in it cost the whole suite while the map went on
 * meaning exactly what it meant before.
 *
 * These pin the sharper question. The map records what it was recorded under,
 * and selection compares that against the configuration in force — so an edit
 * that moved no value narrows as usual, and one that moved a value covsel reads
 * still falls open, whether or not any file changed.
 */

const CONFIG_FILE = 'covsel.config.js';
const ADD = 'export function add(a, b) {\n  return a + b;\n}\n';

let cwd: string;

const git = (args: string[]): string => runGit(cwd, args);
const write = (rel: string, content: string): void => writeFile(cwd, rel, content);
const mapPath = (): string => join(cwd, '.covsel', 'map.json');
const readMap = (): Record<string, unknown> =>
  JSON.parse(readFileSync(mapPath(), 'utf8')) as Record<string, unknown>;

/** The config file as covsel's own repository writes it: values under comments. */
function configFile(comment: string): string {
  return `/* ${comment} */\nexport default {\n  sourceGlobs: ['src/**'],\n};\n`;
}

/** The same values `configFile` holds, as the resolved config selection is given. */
function config(overrides: Partial<CovselConfig> = {}): CovselConfig {
  return resolveConfig({ sourceGlobs: ['src/**'], ...overrides });
}

/** Commit everything, so the diff selection reads is committed history. */
function commit(message: string): void {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
}

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-config-change-'));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  write('src/a.mjs', ADD);
  write(
    'test/a.test.mjs',
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n" +
      "import { add } from '../src/a.mjs';\ntest('adds', () => assert.equal(add(1, 1), 2));\n",
  );
  write(
    'package.json',
    '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
  );
  write('tsconfig.json', '{\n  "compilerOptions": {}\n}\n');
  write(CONFIG_FILE, configFile('what this repository selects over'));
  write('.gitignore', '.covsel/\n');
  runGit(cwd, ['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  commit('base');

  const recorded = config();
  const recorder = createGenericRecorder({
    command: ['node', '--test'],
    cwd,
    config: recorded,
  });
  expect((await recordMap({ cwd, config: recorded, recorder })).ok).toBe(true);
}, 60_000);

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('a config change judged by what it changed', () => {
  it('narrows when only a comment in the config file moved', async () => {
    write(CONFIG_FILE, configFile('reworded, and nothing else'));
    commit('reword the comment');

    const result = await selectAffected({ cwd, config: config() });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual([]);
  });

  it('keeps the full run when the project listed the config file as a sentinel', async () => {
    // covsel's defaults name no config file, so listing one is a deliberate
    // "any change here runs everything" — possibly for a reason covsel cannot
    // see from the values, such as a test that loads the file as data. The
    // narrowing is available by dropping it from the list, not by overruling it.
    write(CONFIG_FILE, configFile('reworded, and nothing else'));
    commit('reword the comment');

    const withSentinel = config({ sentinels: ['package.json', CONFIG_FILE] });
    const result = await selectAffected({ cwd, config: withSentinel });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/sentinel changed: covsel\.config\.js/);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('still selects the tests a source change in the same diff affects', async () => {
    write(CONFIG_FILE, configFile('reworded, and nothing else'));
    write('src/a.mjs', `${ADD}// changed alongside the comment\n`);
    commit('reword the comment and touch a source');

    const result = await selectAffected({ cwd, config: config() });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('falls open when a value the map depends on changed', async () => {
    write(CONFIG_FILE, "export default {\n  sourceGlobs: ['src/lib/**'],\n};\n");
    commit('narrow sourceGlobs');

    const result = await selectAffected({
      cwd,
      config: config({ sourceGlobs: ['src/lib/**'] }),
    });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/sourceGlobs/);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('falls open on differing values even when no file changed', async () => {
    // A config computed from the environment moves without the diff showing it,
    // and a file changed and changed back moves without the diff showing it
    // either. Neither is reachable from the config file's own history, which is
    // why the comparison is with the values rather than with the diff.
    const result = await selectAffected({
      cwd,
      config: config({ sourceGlobs: ['lib/**'] }),
    });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/sourceGlobs/);
    // Not the "no test files matched" full run: discovery is unaffected here.
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('narrows on a field covsel applies from the config in force', async () => {
    write(CONFIG_FILE, `${configFile('now with alwaysRun')}`);
    commit('touch the config');

    const result = await selectAffected({
      cwd,
      config: config({ alwaysRun: ['test/a.test.mjs'] }),
    });
    expect(result.fullRun).toBe(false);
    // Honored from the config in force, rather than forcing a full run for
    // having moved since the recording.
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('keeps the full run for any other changed sentinel', async () => {
    write('tsconfig.json', '{\n  // reworded\n  "compilerOptions": {}\n}\n');
    commit('comment the tsconfig');

    const result = await selectAffected({ cwd, config: config() });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/tsconfig\.json/);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('falls open on any config-file change when the map records no config', async () => {
    const map = readMap();
    delete map.config;
    writeFileSync(mapPath(), JSON.stringify(map));
    write(CONFIG_FILE, configFile('reworded, and nothing else'));
    commit('reword the comment');

    const result = await selectAffected({ cwd, config: config() });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/covsel\.config\.js/);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('narrows when the map records no config and no config file changed', async () => {
    const map = readMap();
    delete map.config;
    writeFileSync(mapPath(), JSON.stringify(map));
    write('src/a.mjs', `${ADD}// changed\n`);
    commit('change a source');

    const result = await selectAffected({ cwd, config: config() });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  });

  it('records the values the map depends on, and not the ones it does not', () => {
    const recorded = readMap().config as Record<string, unknown>;
    expect(recorded).toBeDefined();
    expect(recorded.sourceGlobs).toEqual(['src/**']);
    expect(recorded).not.toHaveProperty('alwaysRun');
    expect(recorded).not.toHaveProperty('sentinels');
    expect(recorded).not.toHaveProperty('store');
    expect(recorded).not.toHaveProperty('adapter');
  });
});
