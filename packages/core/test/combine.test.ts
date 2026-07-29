import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commitAll, write } from './helpers/repo.js';
import {
  agreedScope,
  combineObservations,
  type CovselConfig,
  type Observation,
  type ObservationWindow,
  OBSERVES_EVERYTHING,
  recordMap,
  type Recorder,
  resolveConfig,
  selectAffected,
  unionScopes,
} from '../src/index.js';

/**
 * One test unit, several observation windows. A recorder that watches a browser
 * and the server behind it holds two views of one execution; neither is the
 * test. These are the rules for folding them into a single entry without
 * inventing coverage or claiming visibility no window had.
 */

const window_ = (
  observes: string[],
  files: string[],
  blocks: [file: string, hash: string][] = [],
): Observation => ({
  observes,
  files: files.map((file) => ({ file, fileHash: `sha256:${file}` })),
  blocks: blocks.map(([file, blockHash]) => ({ file, blockHash })),
});

const test_ = { file: 'e2e/checkout.spec.ts', name: 'shows the total' };

describe('coverage from two isolates lands in one entry', () => {
  it('records the sources executed in both', () => {
    const browser = window_(['src/**'], ['src/app.mjs', 'src/cart.mjs']);
    const server = window_(['server/**'], ['server/logic.mjs']);

    const unit = combineObservations(test_, [browser, server]);

    expect(unit.test).toEqual(test_);
    expect(unit.files.map((f) => f.file)).toEqual([
      'server/logic.mjs',
      'src/app.mjs',
      'src/cart.mjs',
    ]);
  });

  it('records a file both windows saw once', () => {
    const unit = combineObservations(test_, [
      window_(['src/**'], ['src/shared.mjs', 'src/app.mjs']),
      window_(['src/**', 'server/**'], ['src/shared.mjs', 'server/logic.mjs']),
    ]);

    expect(unit.files.map((f) => f.file)).toEqual([
      'server/logic.mjs',
      'src/app.mjs',
      'src/shared.mjs',
    ]);
  });
});

describe('blocks for the same file from two isolates are deduplicated', () => {
  it('records each block hash once', () => {
    const shared: [string, string][] = [['src/shared.mjs', 'h-tag']];
    const unit = combineObservations(test_, [
      window_(
        ['src/**'],
        ['src/shared.mjs', 'src/app.mjs'],
        [...shared, ['src/app.mjs', 'h-render']],
      ),
      window_(
        ['src/**', 'server/**'],
        ['src/shared.mjs', 'server/logic.mjs'],
        [...shared, ['server/logic.mjs', 'h-price']],
      ),
    ]);

    expect(unit.blocks.map((b) => `${b.file}:${b.blockHash}`).sort()).toEqual([
      'server/logic.mjs:h-price',
      'src/app.mjs:h-render',
      'src/shared.mjs:h-tag',
    ]);
  });

  it('drops blocks for a file a window recorded without them, and keeps the rest', () => {
    // A window that recorded the file but no blocks for it knows nothing about
    // which of its blocks ran. Keeping the other window's blocks would let a
    // change to a block only this window's isolate executed miss the entry, so
    // that file falls back to file level — and only that file.
    const unit = combineObservations(test_, [
      window_(
        ['src/**'],
        ['src/shared.mjs', 'src/app.mjs'],
        [
          ['src/shared.mjs', 'h-tag'],
          ['src/app.mjs', 'h-render'],
        ],
      ),
      window_(['src/**'], ['src/shared.mjs']),
    ]);

    expect(unit.files.map((f) => f.file)).toEqual(['src/app.mjs', 'src/shared.mjs']);
    expect(unit.blocks.map((b) => b.file)).toEqual(['src/app.mjs']);
  });

  it('lets a window that observed nothing execute keep the entry block-granular', () => {
    // A spec that never reaches the server closes an empty server window. That
    // is a measurement, not missing block data, so it costs the entry nothing.
    const unit = combineObservations(test_, [
      window_(['src/**'], ['src/app.mjs'], [['src/app.mjs', 'h-render']]),
      window_(['server/**'], []),
    ]);

    expect(unit.blocks).toHaveLength(1);
  });
});

describe('combining scopes never widens what was observed', () => {
  it('is the union of what the windows could see', () => {
    const unit = combineObservations(test_, [
      window_(['src/**'], ['src/app.mjs']),
      window_(['server/**'], ['server/logic.mjs']),
    ]);

    expect(unit.observes).toEqual(['src/**', 'server/**']);
  });

  it('does not collapse sibling globs into the parent that covers them', () => {
    // `src/a/**` and `src/b/**` are not `src/**`: a scope is a claim about
    // recall, and the paths between them — `src/c/**`, `src/root.mjs` — were
    // watched by no window. Widening here suppresses the full run they deserve.
    const unit = combineObservations(test_, [
      window_(['src/a/**'], []),
      window_(['src/b/**'], []),
    ]);

    expect(unit.observes).toEqual(['src/a/**', 'src/b/**']);
  });

  it('keeps each glob once, in the order the windows claimed them', () => {
    expect(
      unionScopes([
        ['src/**', 'lib/**'],
        ['lib/**', 'server/**'],
      ]),
    ).toEqual(['src/**', 'lib/**', 'server/**']);
  });

  it('claims nothing for windows that claim nothing', () => {
    expect(unionScopes([[], []])).toEqual([]);
  });
});

describe('one window failing fails the unit', () => {
  it('throws rather than returning the half that worked', () => {
    const windows: ObservationWindow[] = [
      window_(['src/**'], ['src/app.mjs']),
      { failed: 'no source map for /assets/app.9f2c.js' },
    ];

    expect(() => combineObservations(test_, windows)).toThrow(
      /no source map for \/assets\/app\.9f2c\.js/,
    );
  });

  it('names the test whose recording failed', () => {
    expect(() =>
      combineObservations(test_, [{ failed: 'browser reported no coverage' }]),
    ).toThrow(/checkout\.spec\.ts/);
  });

  it('refuses to combine no windows at all', () => {
    // Zero windows would produce a well-formed entry covering nothing, which
    // selection reads as "this test covers no source" and skips forever.
    expect(() => combineObservations(test_, [])).toThrow(/no observations/);
  });
});

describe('agreedScope', () => {
  it('keeps the scope when every recording agrees on it', () => {
    expect(
      agreedScope([
        ['src/**', 'lib/**'],
        ['lib/**', 'src/**'],
      ]),
    ).toEqual(['src/**', 'lib/**']);
  });

  it('claims nothing when they disagree, rather than unioning', () => {
    expect(agreedScope([['src/**'], ['server/**']])).toEqual([]);
  });

  it('claims nothing when there is nothing to agree on', () => {
    expect(agreedScope([])).toEqual([]);
  });
});

/**
 * The end of the rule: a combined scope has to reach the map, or the union is a
 * number nobody consults. These record through a composing recorder and then
 * select, which is the path `covsel record` and `covsel affected` take.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repo with one spec, an app source and a server source, committed. */
function fixture(over: Partial<CovselConfig> = {}): {
  cwd: string;
  config: CovselConfig;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-combine-'));
  dirs.push(cwd);
  write(cwd, 'package.json', '{\n  "name": "fixture",\n  "type": "module"\n}\n');
  write(cwd, '.gitignore', '.covsel/\n');
  write(cwd, 'src/app.mjs', 'export const render = (t) => `total: ${t}`;\n');
  write(cwd, 'server/logic.mjs', 'export const price = (q) => q * 3 + 1;\n');
  // Neither window watches this one, so a change to it has to fall open.
  write(cwd, 'infra/deploy.mjs', 'export const deploy = () => 1;\n');
  write(cwd, 'e2e/checkout.test.mjs', '// driven by the runner\n');
  commitAll(cwd);
  return { cwd, config: resolveConfig(over) };
}

/**
 * A recorder that folds a browser window and a server window into one unit.
 * Declares `OBSERVES_EVERYTHING` unless told otherwise, so what the units report
 * is free to narrow it.
 */
function composingRecorder(
  windows: (file: string) => ObservationWindow[],
  observes: readonly string[] = OBSERVES_EVERYTHING,
): Recorder {
  return {
    observes,
    async record(file: string) {
      return [combineObservations({ file }, windows(file))];
    },
  };
}

describe('a combined scope reaches the map', () => {
  it('narrows the map to the union of the windows', async () => {
    const { cwd, config } = fixture();
    const recorder = composingRecorder(() => [
      window_(['src/**'], ['src/app.mjs']),
      window_(['server/**'], ['server/logic.mjs']),
    ]);

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(true);
    expect(result.map!.observed).toEqual(['src/**', 'server/**']);
  });

  it('selects the spec for a change to either isolate’s source', async () => {
    const { cwd, config } = fixture();
    await recordMap({
      cwd,
      config,
      recorder: composingRecorder(() => [
        window_(['src/**'], ['src/app.mjs']),
        window_(['server/**'], ['server/logic.mjs']),
      ]),
    });

    write(cwd, 'server/logic.mjs', 'export const price = (q) => q * 4 + 1;\n');

    const selection = await selectAffected({ cwd, config });
    expect(selection.fullRun).toBe(false);
    expect(selection.tests).toEqual(['e2e/checkout.test.mjs']);
  });

  it('still forces a full run for a change neither window could see', async () => {
    const { cwd, config } = fixture();
    await recordMap({
      cwd,
      config,
      recorder: composingRecorder(() => [
        window_(['src/**'], ['src/app.mjs']),
        window_(['server/**'], ['server/logic.mjs']),
      ]),
    });

    write(cwd, 'infra/deploy.mjs', 'export const deploy = () => 2;\n');

    const selection = await selectAffected({ cwd, config });
    expect(selection.fullRun).toBe(true);
    expect(selection.reason).toContain('infra/deploy.mjs');
  });

  it('claims nothing when units were observed by different window sets', async () => {
    // One spec never opened a page, so its entry was watched by the server
    // window alone. A map-level scope wide enough for the other entry would
    // vouch for paths that entry's windows were not watching.
    const { cwd, config } = fixture();
    write(cwd, 'e2e/api.test.mjs', '// server only\n');
    const recorder = composingRecorder((file) =>
      file === 'e2e/api.test.mjs'
        ? [window_(['server/**'], ['server/logic.mjs'])]
        : [window_(['src/**'], ['src/app.mjs']), window_(['server/**'], [])],
    );

    const result = await recordMap({ cwd, config, recorder });

    expect(result.map!.observed).toEqual([]);
    write(cwd, 'src/app.mjs', 'export const render = (t) => `sum: ${t}`;\n');
    expect((await selectAffected({ cwd, config })).fullRun).toBe(true);
  });

  it('leaves a recorder that reports no per-unit scope exactly as it was', async () => {
    const { cwd, config } = fixture();
    const recorder: Recorder = {
      observes: ['src/**'],
      async record(file: string) {
        return [{ test: { file }, files: [], blocks: [] }];
      },
    };

    const result = await recordMap({ cwd, config, recorder });

    expect(result.map!.observed).toEqual(['src/**']);
  });

  it('writes no map when a window failed', async () => {
    const { cwd, config } = fixture();
    const recorder = composingRecorder(() => [
      window_(['src/**'], ['src/app.mjs']),
      { failed: 'browser reported no coverage' },
    ]);

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    expect(result.failures[0]!.reason).toContain('browser reported no coverage');
    expect(existsSync(result.mapPath)).toBe(false);
  });
});

/**
 * The recorder's declaration is a ceiling. Units say which windows watched a
 * given entry, which can only ever be less than what the recorder claimed it
 * could see — a unit claiming more is a contradiction, and believing it turns
 * the recorder's own admission that it is blind somewhere into a map asserting
 * it was watching.
 */
describe('units may narrow a recorder’s scope, never widen it', () => {
  it('fails the recording when a unit claims a glob the recorder does not', async () => {
    const { cwd, config } = fixture();
    // The honest declaration of a recorder that cannot see the app server.
    const recorder = composingRecorder(
      () => [
        window_(['src/**'], ['src/app.mjs']),
        window_(['server/**'], ['server/logic.mjs']),
      ],
      ['src/**'],
    );

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(false);
    expect(result.failures[0]!.reason).toContain('server/**');
    expect(existsSync(result.mapPath)).toBe(false);
  });

  it('never lets that over-claim deselect a change the recorder could not see', async () => {
    // The regression this rule exists for. The server window claims `server/**`
    // but records nothing there — which is what a recorder blind to the server
    // looks like. Stamping the union would make the map's silence about
    // `server/logic.mjs` read as "did not run", and the spec would not run.
    const { cwd, config } = fixture();
    const recorder = composingRecorder(
      () => [window_(['src/**'], ['src/app.mjs']), window_(['server/**'], [])],
      ['src/**'],
    );

    const failed = await recordMap({ cwd, config, recorder });
    expect(failed.ok).toBe(false);

    // With the map refused, there is nothing to select against, so the change
    // runs everything — the fail-open answer.
    write(cwd, 'server/logic.mjs', 'export const price = (q) => q * 4 + 1;\n');
    const selection = await selectAffected({ cwd, config });
    expect(selection.fullRun).toBe(true);
    expect(selection.tests).toEqual(['e2e/checkout.test.mjs']);
  });

  it('accepts the declaration a composing recorder should make', async () => {
    const { cwd, config } = fixture();
    const recorder = composingRecorder(
      () => [
        window_(['src/**'], ['src/app.mjs']),
        window_(['server/**'], ['server/logic.mjs']),
      ],
      unionScopes([['src/**'], ['server/**']]),
    );

    const result = await recordMap({ cwd, config, recorder });

    expect(result.ok).toBe(true);
    expect(result.map!.observed).toEqual(['src/**', 'server/**']);
  });

  it('lets units narrow a wider declaration', async () => {
    const { cwd, config } = fixture();
    const recorder = composingRecorder(
      () => [window_(['src/**'], ['src/app.mjs'])],
      ['src/**', 'server/**'],
    );

    const result = await recordMap({ cwd, config, recorder });

    expect(result.map!.observed).toEqual(['src/**']);
    // And the narrowing is what selection is then held to.
    write(cwd, 'server/logic.mjs', 'export const price = (q) => q * 4 + 1;\n');
    expect((await selectAffected({ cwd, config })).fullRun).toBe(true);
  });
});

describe('a downgraded file still selects through the map', () => {
  it('selects the spec when a block-less window shares the file', async () => {
    // The per-file downgrade, exercised the way selection sees it rather than on
    // the pure function: the browser window recorded blocks for `src/app.mjs`,
    // the server window recorded the same file with none. A change to a block of
    // it that only the server executed is not among the recorded hashes, so an
    // entry keeping the browser's blocks would not match — and the spec would be
    // skipped. Dropping that file to file level is what keeps it selected.
    const { cwd, config } = fixture({ granularity: 'block' });
    const recorder = composingRecorder(() => [
      window_(['src/**'], ['src/app.mjs'], [['src/app.mjs', 'browser-block']]),
      window_(['src/**'], ['src/app.mjs']),
    ]);

    const recorded = await recordMap({ cwd, config, recorder });
    expect(recorded.ok).toBe(true);
    expect(recorded.map!.entries[0]!.blocks ?? []).toEqual([]);

    write(cwd, 'src/app.mjs', 'export const render = (t) => `sum: ${t}`;\n');

    const selection = await selectAffected({ cwd, config });
    expect(selection.fullRun).toBe(false);
    expect(selection.tests).toEqual(['e2e/checkout.test.mjs']);
  });

  it('keeps selecting by block for a file no window left unknown', async () => {
    // The other half: precision is not given up where every window that saw the
    // file recorded its blocks, so an unrelated file's change still selects
    // nothing.
    const { cwd, config } = fixture({ granularity: 'block' });
    const recorder = composingRecorder(() => [
      window_(['src/**', 'server/**'], ['src/app.mjs'], [['src/app.mjs', 'h-render']]),
      window_(['src/**', 'server/**'], ['server/logic.mjs'], [['server/logic.mjs', 'h']]),
    ]);

    const recorded = await recordMap({ cwd, config, recorder });
    expect(recorded.map!.entries[0]!.blocks).toHaveLength(2);
  });
});
