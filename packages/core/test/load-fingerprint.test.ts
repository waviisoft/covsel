import { describe, expect, it } from 'vitest';

import {
  blockHashesOf,
  extractBlocks,
  LOAD_BLOCK,
  MODULE_BLOCK,
  selectExecutedBlocks,
} from '../src/index.js';

/**
 * What a module does when it loads, told apart from what it declares —
 * covsel/covsel#82.
 *
 * A file a test imported and never called into used to be credited with nothing
 * on the istanbul-shaped adapters, which is the fail-closed direction: give that
 * module a top-level side effect, or make it throw on import, and every importer
 * behaves differently while none of them are selected.
 *
 * Crediting it with the module block would close the hole and cost most of the
 * precision, because the module block moves whenever a signature does. So it is
 * credited with this instead, and the two properties below are the whole of why
 * that is worth the extra concept: a declarations-only module never selects its
 * importers, and the moment it gains load-time behaviour it selects them once.
 */

/** The load block's hash for a source. */
function load(source: string): string {
  const block = extractBlocks(source).find((b) => b.name === LOAD_BLOCK);
  if (block === undefined) throw new Error('no load block');
  return block.hash;
}

/** The module block's hash for a source. */
function moduleBlock(source: string): string {
  const block = extractBlocks(source).find((b) => b.name === MODULE_BLOCK);
  if (block === undefined) throw new Error('no module block');
  return block.hash;
}

describe('what a load fingerprint ignores', () => {
  it('is unmoved by adding a function', () => {
    const before = `import { a } from './a.js';\nexport function one() {\n  return a;\n}\n`;
    const after = `${before}export function two() {\n  return 2;\n}\n`;

    expect(load(after)).toBe(load(before));
    // The contrast that makes the concept worth having: the module block does
    // move, which is why crediting an imported-but-uncalled file with it would
    // re-select every importer on the commonest edit there is.
    expect(moduleBlock(after)).not.toBe(moduleBlock(before));
  });

  it('is unmoved by renaming or re-typing a function', () => {
    const before = `export function one(a: string): string {\n  return a;\n}\n`;
    const renamed = `export function uno(a: string): string {\n  return a;\n}\n`;
    const retyped = `export function one(a: number): number {\n  return a;\n}\n`;

    expect(load(renamed)).toBe(load(before));
    expect(load(retyped)).toBe(load(before));
  });

  it('is unmoved by taking one more binding from a module already imported', () => {
    // The specifier is what loading resolves and evaluates. Which names are
    // lifted out of it is settled before anything runs.
    const before = `import { a } from './x.js';\nexport function one() {\n  return a;\n}\n`;
    const after = `import { a, b } from './x.js';\nexport function one() {\n  return a + b;\n}\n`;

    expect(load(after)).toBe(load(before));
  });

  it('is unmoved by types, interfaces, and type-only imports', () => {
    const before = `import type { T } from './t.js';\nexport function one() {\n  return 1;\n}\n`;
    const after =
      `import type { T, U } from './t.js';\n` +
      `interface Shape {\n  a: string;\n}\n` +
      `type Alias = Shape | null;\n` +
      `export function one() {\n  return 1;\n}\n`;

    expect(load(after)).toBe(load(before));
  });

  it('is empty for a module that declares and does nothing', () => {
    // The property everything else rests on: an empty fingerprint cannot change,
    // so a declarations-only module never selects its importers.
    const declarations = `export function one() {\n  return 1;\n}\ninterface I {\n  a: 1;\n}\n`;
    const other = `export function somethingElse(a: number) {\n  return a;\n}\n`;

    expect(load(declarations)).toBe(load(other));
    expect(load(declarations)).toBe(load(''));
  });
});

describe('what a load fingerprint catches', () => {
  it('moves when a module gains a top-level side effect', () => {
    // The case the hole was open for.
    const before = `export function one() {\n  return 1;\n}\n`;
    const after = `globalThis.patched = true;\nexport function one() {\n  return 1;\n}\n`;

    expect(load(after)).not.toBe(load(before));
  });

  it('moves when a module is newly imported for its side effects', () => {
    const before = `export function one() {\n  return 1;\n}\n`;
    const after = `import './register-globals.js';\nexport function one() {\n  return 1;\n}\n`;

    expect(load(after)).not.toBe(load(before));
  });

  it('moves when a barrel re-exports one more module', () => {
    // A barrel is all declarations and no statements, but `export * from` loads
    // the module exactly as an import does, so its specifiers count.
    const before = `export * from './a.js';\nexport * from './b.js';\n`;
    const after = `${before}export * from './c.js';\n`;

    expect(load(after)).not.toBe(load(before));
  });

  it('moves when a top-level initialiser changes', () => {
    const before = `export const registry = new Map();\n`;
    const after = `export const registry = new Map([['seed', 1]]);\n`;

    expect(load(after)).not.toBe(load(before));
  });

  it('moves when a top-level await changes', () => {
    const before = `const config = await load('a');\n`;
    const after = `const config = await load('b');\n`;

    expect(load(after)).not.toBe(load(before));
  });

  it('is reachable through the same hash set selection compares against', () => {
    // `blockHashesOf` is what `annotateChangedBlocks` diffs, so a load block
    // nobody could see there would be recorded and never matched.
    const source = `import './side-effect.js';\nexport function one() {\n  return 1;\n}\n`;

    expect(blockHashesOf(source).has(load(source))).toBe(true);
  });
});

describe('which block a recording credits', () => {
  const SRC = `import './x.js';\nexport function one() {\n  return 1;\n}\n`;

  it('credits the load block when the file was only imported', () => {
    // No function ran, so nothing here can be affected by a signature.
    const blocks = selectExecutedBlocks(SRC, 'src/a.ts', [
      { start: SRC.indexOf('{\n  return 1'), end: SRC.length, count: 0 },
    ]);

    expect(blocks.map((b) => b.name)).toEqual([LOAD_BLOCK]);
  });

  it('credits the module block when the test called into the file', () => {
    // It genuinely executes code there, so a signature change can reach it and
    // the wider block is the honest one.
    const blocks = selectExecutedBlocks(SRC, 'src/a.ts', [
      { start: SRC.indexOf('{\n  return 1'), end: SRC.length, count: 3 },
    ]);

    expect(blocks.map((b) => b.name)).toEqual([MODULE_BLOCK, 'one']);
  });
});
