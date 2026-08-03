import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  changedConfigFields,
  type CovselConfig,
  createGenericRecorder,
  recordedConfig,
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
    //
    // Recorded under that list, so the listing is the only thing under test: a
    // map recorded without it would report the moved `sentinels` field instead,
    // which is a full run for a different reason.
    const withSentinel = config({ sentinels: ['package.json', CONFIG_FILE] });
    const recorder = createGenericRecorder({
      command: ['node', '--test'],
      cwd,
      config: withSentinel,
    });
    expect((await recordMap({ cwd, config: withSentinel, recorder })).ok).toBe(true);

    write(CONFIG_FILE, configFile('reworded, and nothing else'));
    commit('reword the comment');

    const result = await selectAffected({ cwd, config: withSentinel });
    expect(result.fullRun).toBe(true);
    expect(result.reason).toMatch(/sentinel changed: covsel\.config\.js/);
    expect(result.tests).toEqual(['test/a.test.mjs']);
  }, 60_000);

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

  it('falls open when alwaysRun or sentinels move, for the diff that removes one', async () => {
    // Both are read from the config in force, so neither can leave the map
    // meaning one thing while selection reads another. The commit that *drops*
    // a sentinel is why they are compared anyway: it edits the file it just
    // stopped protecting, and nothing else would run a test for it.
    write(CONFIG_FILE, `${configFile('now with alwaysRun')}`);
    commit('touch the config');

    const dropped = await selectAffected({
      cwd,
      config: config({ alwaysRun: ['test/a.test.mjs'] }),
    });
    expect(dropped.fullRun).toBe(true);
    expect(dropped.reason).toMatch(/alwaysRun/);

    const sentinels = await selectAffected({
      cwd,
      config: config({ sentinels: ['package.json'] }),
    });
    expect(sentinels.fullRun).toBe(true);
    expect(sentinels.reason).toMatch(/sentinels/);
  });

  it('narrows when only the store location moved', async () => {
    // The one field a map records nothing about: it says where the map is kept,
    // not what it says. A different archive directory reads the same map.
    write(CONFIG_FILE, `${configFile('archived elsewhere')}`);
    commit('touch the config');

    const result = await selectAffected({
      cwd,
      config: config({ store: { dir: '.covsel', archiveDir: 'somewhere-else' } }),
    });
    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual([]);
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

  it('falls open rather than throwing on a map whose recorded config is unreadable', async () => {
    // `isUsableMap` does not look inside this field, so a hand-edited or
    // foreign map can carry anything here. Every shape has to reach the same
    // answer as recording none at all -- a stack trace out of `affected` is not
    // a full run, and covsel would have stopped rather than over-selected.
    for (const value of [null, 42, 'config', ['sourceGlobs'], undefined]) {
      const map = readMap();
      if (value === undefined) delete map.config;
      else map.config = value;
      writeFileSync(mapPath(), JSON.stringify(map));

      const result = await selectAffected({ cwd, config: config() });
      expect(result.fullRun).toBe(false);

      const changed = await selectAffected({
        cwd,
        config: config({ sourceGlobs: ['lib/**'] }),
      });
      // Nothing to compare against, so the diff answers instead: no config file
      // changed here, which is why this one narrows rather than falling open.
      expect(changed.fullRun).toBe(false);
    }
  });

  it('records a digest per compared field, and no values', () => {
    const recorded = readMap().config as Record<string, unknown>;
    expect(recorded).toBeDefined();
    // Values never leave the machine that recorded them: a map is published to
    // an archive others fetch, and buildDirs can hold absolute paths.
    expect(JSON.stringify(recorded)).not.toContain('src/**');
    expect(recorded['sourceGlobs']).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(recorded).not.toHaveProperty('store');
  });

  it('compares every field it records, so a new one is compared from the day it exists', () => {
    // The guard for the denylist's central claim. Without it, moving any field
    // into the inert list passes the whole suite, and the field silently stops
    // forcing a full run when it moves.
    const base = resolveConfig({ sourceGlobs: ['src/**'] });
    const recorded = recordedConfig(base);
    const perturbed: Record<string, unknown> = {
      testGlobs: ['other/**'],
      sourceGlobs: ['other/**'],
      alwaysRun: ['other/**'],
      sentinels: ['other.json'],
      adapter: 'some-other-adapter',
      granularity: 'file',
      sourceMaps: { buildDirs: [], http: false, allowUnmappable: ['x'] },
    };
    for (const field of Object.keys(recorded)) {
      const value = perturbed[field];
      expect(value, `${field} has no perturbation in this test`).toBeDefined();
      const moved = recordedConfig({ ...base, [field]: value } as typeof base);
      expect(changedConfigFields(recorded, moved), field).toEqual([field]);
    }
    // And the fields the config has that a map deliberately records nothing
    // about, so this stays a two-sided statement rather than a tautology.
    expect(Object.keys(recorded).sort()).toEqual(
      Object.keys(base)
        .filter((f) => f !== 'store')
        .sort(),
    );
  });

  it('treats a value it cannot serialise as changed, never as equal', () => {
    // A config file is `.js` and is never type-checked, so a field can hold a
    // RegExp, a Map, or a function. Rendering own properties makes every one of
    // those `{}`, and two different values reading as equal is what narrows a
    // selection against a map recorded under the other one.
    const base = resolveConfig();
    const withRegex = (source: string) =>
      recordedConfig({
        ...base,
        sourceMaps: { ...base.sourceMaps, allowUnmappable: [/x/] as unknown as string[] },
        sourceGlobs: [source],
      });
    expect(changedConfigFields(withRegex('a'), withRegex('a'))).toContain('sourceMaps');

    const withFn = (fn: () => void) =>
      recordedConfig({ ...base, alwaysRun: [fn] as unknown as string[] });
    expect(
      changedConfigFields(
        withFn(() => 1),
        withFn(() => 2),
      ),
    ).toEqual(['alwaysRun']);

    // A plain nested object still compares by content, so the marker is not
    // swallowing everything into "always changed".
    const buildDirs = (dir: string) =>
      recordedConfig({
        ...base,
        sourceMaps: { ...base.sourceMaps, buildDirs: [{ urlPrefix: '/', dir }] },
      });
    expect(changedConfigFields(buildDirs('dist'), buildDirs('dist'))).toEqual([]);
    expect(changedConfigFields(buildDirs('dist'), buildDirs('build'))).toEqual([
      'sourceMaps',
    ]);
  });

  it('reads a key that merely moved as no change at all', () => {
    const ordered = recordedConfig(
      resolveConfig({
        sourceMaps: { http: true, allowUnmappable: ['a'], buildDirs: [] },
      }),
    );
    const reordered = recordedConfig(
      resolveConfig({
        sourceMaps: { buildDirs: [], allowUnmappable: ['a'], http: true },
      }),
    );
    expect(changedConfigFields(ordered, reordered)).toEqual([]);
  });
});
