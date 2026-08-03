import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  changedBlockHashes,
  type CoverageMap,
  createGenericRecorder,
  extractBlocks,
  recordMap,
  resolveConfig,
  selectAffected,
} from '../src/index.js';

/**
 * A function's hash covers its own code, at every depth.
 *
 * The module block is canonicalized with every outermost function body blanked
 * out, so an edit inside a function does not change the module's hash. One level
 * down that was not true: a function block was canonicalized with an empty
 * exclusion list, so a function's hash included its nested functions' bodies
 * verbatim and editing an inner function changed every enclosing one.
 *
 * That is over-selection, which is safe and invisible until you look for it —
 * and it is where block precision goes to die in component frameworks, since
 * React, Vue, and Svelte all put handlers and effects *inside* a component
 * function. Block granularity silently collapsed to component granularity.
 *
 * A nested function's *signature* deliberately stays with its parent: the parent
 * evaluates the function expression, so its parameter list and its position
 * among the parent's statements are the parent's own code. That is the same rule
 * the module block already applies to top-level functions, now applied at every
 * depth rather than only at the top.
 */

const CART = `export function Cart(items) {
  const label = 'Cart (' + items.length + ')';
  function onClick(item) {
    return [...items, item];
  }
  function onHover(item) {
    return items.indexOf(item);
  }
  return { label, onClick, onHover };
}
`;

function hashes(source: string): Map<string, string> {
  return new Map(extractBlocks(source).map((b) => [b.name, b.hash]));
}

describe('a block hash covers its own code', () => {
  it('does not change the enclosing function when a nested body changes', () => {
    const before = hashes(CART);
    const after = hashes(CART.replace('[...items, item]', '[item, ...items]'));

    expect(after.get('onClick')).not.toBe(before.get('onClick'));
    expect(after.get('Cart')).toBe(before.get('Cart'));
    expect(after.get('<module>')).toBe(before.get('<module>'));
  });

  it('still changes the enclosing function when its own statements change', () => {
    const before = hashes(CART);
    const after = hashes(CART.replace("'Cart ('", "'Basket ('"));

    expect(after.get('Cart')).not.toBe(before.get('Cart'));
    expect(after.get('onClick')).toBe(before.get('onClick'));
  });

  it('keeps a nested signature with the parent that constructs the closure', () => {
    // The deliberate half of the rule: the parameter list is part of how the
    // parent builds the function, so a change to it is a change to the parent's
    // code and selects the parent's tests. It is the child's signature too, so
    // both hashes move.
    const before = hashes(CART);
    const after = hashes(CART.replace('function onClick(item)', 'function onClick(row)'));

    expect(after.get('Cart')).not.toBe(before.get('Cart'));
    expect(after.get('onClick')).not.toBe(before.get('onClick'));
  });

  it('applies at every depth, not just one level in', () => {
    const source = `function outer() {
  function middle() {
    function inner() {
      return 1;
    }
    return inner;
  }
  return middle;
}
`;
    const before = hashes(source);
    const after = hashes(source.replace('return 1;', 'return 2;'));

    expect(after.get('inner')).not.toBe(before.get('inner'));
    expect(after.get('middle')).toBe(before.get('middle'));
    expect(after.get('outer')).toBe(before.get('outer'));
    expect(after.get('<module>')).toBe(before.get('<module>'));
  });

  it('blanks a nested arrow the same way, expression body and all', () => {
    const source = `export function useThing(n) {
  const double = (x) => x * 2;
  return double(n);
}
`;
    const before = hashes(source);
    const after = hashes(source.replace('x * 2', 'x * 3'));

    expect(after.get('double')).not.toBe(before.get('double'));
    expect(after.get('useThing')).toBe(before.get('useThing'));
  });

  it('still emits one block per function, module first, parents before children', () => {
    expect(extractBlocks(CART).map((b) => b.name)).toEqual([
      '<module>',
      'Cart',
      'onClick',
      'onHover',
    ]);
  });

  it('is still stable across reformatting', () => {
    const reformatted = CART.replace(/\n/g, '\n\n').replace(
      'return [...items, item];',
      '      return    [...items, item];',
    );
    for (const [name, hash] of hashes(CART)) {
      expect(hashes(reformatted).get(name)).toBe(hash);
    }
  });
});

describe('no edit disappears between the blocks', () => {
  /**
   * The fail-open guard for blanking: every one of these edits must still show
   * up as some block whose hash changed. Blanking a span in the parent is only
   * safe while the child block covers it verbatim, and an edit that changed no
   * hash at all is an edit that selects no tests.
   */
  const edits: [what: string, edited: string][] = [
    ['a nested body', CART.replace('[...items, item]', '[item, ...items]')],
    ['a nested signature', CART.replace('function onClick(item)', 'function onClick()')],
    ['a statement of the parent itself', CART.replace("'Cart ('", "'Basket ('")],
    [
      'the signature of the parent itself',
      CART.replace('function Cart(items)', 'function Cart(rows)'),
    ],
    [
      'deleting the body of the nested function',
      CART.replace('return [...items, item];', ''),
    ],
    [
      'deleting the nested function',
      CART.replace(/ {2}function onClick[\s\S]*?\n {2}}\n/, ''),
    ],
    [
      'reordering the statements of the parent',
      `export function Cart(items) {
  function onClick(item) {
    return [...items, item];
  }
  const label = 'Cart (' + items.length + ')';
  return { label, onClick };
}
`,
    ],
    ['a top-level statement', `const VERSION = 1;\n${CART}`],
  ];

  it.each(edits)('changing %s changes a block hash', (_what, edited) => {
    expect(changedBlockHashes(CART, edited)).not.toHaveLength(0);
  });
});

describe('permuting same-named siblings is not invisible either', () => {
  /**
   * The other half of that guard, and the reason a block is hashed under its
   * position in the nesting rather than by name alone.
   *
   * Blanking a body out of the parent is sound only while the child block covers
   * it *distinguishably*. Two sibling callbacks that share a name would
   * otherwise hash to each other's values when their bodies are exchanged — and
   * since blocks are compared as a multiset, reordering them would register as
   * no change to any block in the file. `<anonymous>` makes that the ordinary
   * case rather than an exotic one: two `useEffect` calls in one component are
   * two same-named siblings, and effect order is behavior.
   */
  const permutations: [what: string, before: string, after: string][] = [
    [
      'two effects in a component',
      'export function Panel({ id }) {\n  useEffect(() => { subscribe(id); }, [id]);\n  useEffect(() => { track(id); }, [id]);\n  return null;\n}\n',
      'export function Panel({ id }) {\n  useEffect(() => { track(id); }, [id]);\n  useEffect(() => { subscribe(id); }, [id]);\n  return null;\n}\n',
    ],
    [
      'two anonymous callbacks in one function',
      'function C() {\n  run(() => { a(); });\n  run(() => { b(); });\n}\n',
      'function C() {\n  run(() => { b(); });\n  run(() => { a(); });\n}\n',
    ],
    [
      'two anonymous callbacks at different depths',
      'function C() {\n  run(() => { a(); });\n  function g() { run(() => { b(); }); }\n}\n',
      'function C() {\n  run(() => { b(); });\n  function g() { run(() => { a(); }); }\n}\n',
    ],
    [
      'two object literals with the same method name',
      'function C() {\n  use({ m() { a(); } });\n  use({ m() { b(); } });\n}\n',
      'function C() {\n  use({ m() { b(); } });\n  use({ m() { a(); } });\n}\n',
    ],
    [
      'two nested classes with the same method name',
      'function C() {\n  class X { m() { a(); } }\n  class Y { m() { b(); } }\n  return [X, Y];\n}\n',
      'function C() {\n  class X { m() { b(); } }\n  class Y { m() { a(); } }\n  return [X, Y];\n}\n',
    ],
    [
      'two anonymous callbacks at the top level',
      'run(() => { a(); });\nrun(() => { b(); });\n',
      'run(() => { b(); });\nrun(() => { a(); });\n',
    ],
  ];

  it.each(permutations)('exchanging %s changes a block hash', (_what, before, after) => {
    expect(changedBlockHashes(before, after, 'p.tsx')).not.toHaveLength(0);
  });
});

/**
 * The measured case from the issue, in plain JavaScript: two tests that both
 * build the component and one that also calls its handler. Editing the handler
 * used to select both, because both executed the enclosing function whose hash
 * carried the handler's body.
 */
const config = resolveConfig();

const FILES: Record<string, string> = {
  'src/cart.mjs': CART,
  'test/render.test.mjs':
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n" +
    "import { Cart } from '../src/cart.mjs';\n" +
    "test('renders', () => assert.equal(Cart(['a']).label, 'Cart (1)'));\n",
  'test/click.test.mjs':
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n" +
    "import { Cart } from '../src/cart.mjs';\n" +
    "test('clicks', () => assert.deepEqual(Cart(['a']).onClick('b'), ['a', 'b']));\n",
  'package.json': `{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n`,
  '.gitignore': `.covsel/\n`,
};

let cwd: string;
let recordedMap: CoverageMap;
let mapBackup: string;

function git(args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function write(rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'covsel-nested-'));
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'covsel test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'fixture']);

  const recorder = createGenericRecorder({ command: ['node', '--test'], cwd, config });
  const result = await recordMap({ cwd, config, recorder });
  expect(result.ok).toBe(true);
  recordedMap = result.map!;
  mapBackup = JSON.stringify(recordedMap, null, 2);
}, 60_000);

afterEach(() => {
  git(['checkout', '--', '.']);
  git(['clean', '-fd']);
  writeFileSync(join(cwd, config.store.dir, 'map.json'), mapBackup);
});

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe('selection lands on the handler, not the component', () => {
  it('records the handler only for the test that called it', () => {
    const blocksOf = (file: string): string[] =>
      (recordedMap.entries.find((e) => e.test.file === file)?.blocks ?? []).map(
        (b) => b.blockHash,
      );
    const onClick = extractBlocks(CART).find((b) => b.name === 'onClick')!.hash;

    expect(blocksOf('test/click.test.mjs')).toContain(onClick);
    expect(blocksOf('test/render.test.mjs')).not.toContain(onClick);
  });

  it('selects only the test that clicked when the handler body changes', async () => {
    write('src/cart.mjs', CART.replace('[...items, item]', '[item, ...items]'));
    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual(['test/click.test.mjs']);
  });

  it('still selects both when the component body itself changes', async () => {
    // The other half of the guarantee: narrowing the handler must not narrow
    // anything else. Both tests execute the component body, so both run.
    write('src/cart.mjs', CART.replace("'Cart ('", "'Basket ('"));
    const result = await selectAffected({ cwd, config });

    expect(result.tests).toEqual(['test/click.test.mjs', 'test/render.test.mjs']);
  });

  it('still selects both when the handler signature changes', async () => {
    write(
      'src/cart.mjs',
      CART.replace('function onClick(item)', 'function onClick(row)'),
    );
    const result = await selectAffected({ cwd, config });

    expect(result.tests).toEqual(['test/click.test.mjs', 'test/render.test.mjs']);
  });

  it('selects nothing for a nested function no test ever executed', async () => {
    // `onHover` is built every time the component is, and called by neither
    // test. Blanking its body out of the component is what leaves this to the
    // coverage measurement rather than to the component's hash, so this is the
    // assertion that the narrowing rests on being right: nothing recorded runs
    // this code, and nothing is selected for it.
    write('src/cart.mjs', CART.replace('items.indexOf(item)', 'items.lastIndexOf(item)'));
    const result = await selectAffected({ cwd, config });

    expect(result.fullRun).toBe(false);
    expect(result.tests).toEqual([]);
  });
});
