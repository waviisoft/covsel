import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural checks on `action.yml`.
 *
 * A composite action's outputs are wired to step ids by name, and GitHub does
 * not complain when a name matches nothing -- the output simply resolves to the
 * empty string. So renaming a step id silently blanks every output that referred
 * to it, the action still succeeds, and a caller branching on `full-run` reads
 * `''` rather than `'true'`. Nothing else in this repository would notice.
 *
 * Read as text rather than parsed: an action has no build step and no
 * dependencies, so there is no YAML parser here to lean on, and the two things
 * worth checking are both name references.
 */

const source = readFileSync(
  fileURLToPath(new URL('../action.yml', import.meta.url)),
  'utf8',
);

/** Step ids the file declares, e.g. `      id: setup`. */
const declaredIds = new Set(
  [...source.matchAll(/^\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]),
);

describe('action.yml', () => {
  it('declares the step ids its expressions refer to', () => {
    const referenced = new Set(
      [...source.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\./g)].map((m) => m[1]),
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const id of referenced) expect(declaredIds).toContain(id);
  });

  it('wires every declared output to a step', () => {
    // An output block whose `value:` names nothing resolves to '' for every
    // caller, which is indistinguishable from covsel having said nothing.
    const outputs = source.slice(source.indexOf('\noutputs:'), source.indexOf('\nruns:'));
    const values = [...outputs.matchAll(/value:\s*\$\{\{\s*([^}]+?)\s*\}\}/g)].map(
      (m) => m[1],
    );
    expect(values.length).toBeGreaterThan(0);
    for (const value of values)
      expect(value).toMatch(/^steps\.[A-Za-z0-9_-]+\.outputs\./);
  });

  it('runs the tests through covsel run, never through the reported file list', () => {
    // The fail-open guarantee, as a property of the file. `covsel run` hands the
    // runner an unfiltered command on a full run; feeding it the selection
    // instead would run nothing whenever that list came back empty.
    expect(source).toMatch(/\$COVSEL run \$ADAPTER -- \$COMMAND/);
    expect(source).not.toMatch(/xargs/);
    expect(source).not.toMatch(/steps\.report\.outputs\.affected[\s\S]{0,200}run:/);
  });
});
