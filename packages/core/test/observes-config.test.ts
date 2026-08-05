import { describe, expect, it } from 'vitest';

import {
  changedConfigFields,
  type CovselConfigInput,
  recordedConfig,
  resolveConfig,
} from '../src/index.js';

/**
 * `observes` in the project's configuration: the one scope covsel cannot work
 * out for itself.
 *
 * Most recorders can. One watching a Node process tree covsel started sees every
 * script that tree loads; one watching a browser sees only what the build shipped
 * there, and which repo paths those are is a fact about the project's build
 * layout. So the project states it, and what it states is a claim recording is
 * held to — which makes both the absence of a default and the field's presence in
 * what a map records load-bearing.
 */

const recorded = (input: CovselConfigInput) => recordedConfig(resolveConfig(input));

describe('the scope a project declares', () => {
  it('is absent when unset, rather than defaulted either way', () => {
    // Both defaults are wrong, in opposite directions. `**` claims a browser
    // recording watched the server, so a change there reads as touching code no
    // test covers and skips every test. `[]` makes every change fall open, which
    // is a full run wearing selection's clothes. Absent is the recorder's cue to
    // use its own declaration, or to refuse.
    expect(resolveConfig({}).observes).toBeUndefined();
  });

  it('is carried through exactly as written', () => {
    // Read as written, never widened to a glob that happens to cover it: a scope
    // is a claim about recall, and `src/**` standing in for `src/client/**` would
    // suppress the full runs a change under `src/server/**` has to cause.
    expect(resolveConfig({ observes: ['src/client/**'] }).observes).toEqual([
      'src/client/**',
    ]);
  });

  it('keeps an explicitly empty declaration rather than reading it as unset', () => {
    // An adapter that requires the declaration refuses either way, and the two
    // deserve the same refusal — but they are different statements, and turning
    // one into the other here would decide that for every future reader.
    expect(resolveConfig({ observes: [] }).observes).toEqual([]);
  });
});

describe('what a change to that scope does to a recorded map', () => {
  it('is a change the map notices', () => {
    // The map is stamped with what the recording could see, and selection reads
    // that stamp to decide what falls open. Widening the declaration without
    // re-recording would have the old map vouch for paths nothing ever watched.
    expect(changedConfigFields(recorded({ observes: ['src/**'] }), recorded({}))).toEqual(
      ['observes'],
    );
    expect(
      changedConfigFields(
        recorded({ observes: ['src/**'] }),
        recorded({ observes: ['src/**', 'server/**'] }),
      ),
    ).toEqual(['observes']);
  });

  it('is not a change when the declaration is the same', () => {
    expect(
      changedConfigFields(
        recorded({ observes: ['src/**'] }),
        recorded({ observes: ['src/**'] }),
      ),
    ).toEqual([]);
  });
});
