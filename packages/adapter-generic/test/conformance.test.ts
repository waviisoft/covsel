import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import { genericAdapter } from '../src/index.js';

/**
 * The test file imports only its own source; that source reaches the shared one.
 * A recorder that credits a test with the files its test file names, and nothing
 * those reach in turn, therefore fails rather than looking perfect.
 */
const test = (label: string, source: string, fn: string) =>
  [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `import { ${fn} } from '../${source}';`,
    `test('${fn}', () => {`,
    `  appendFileSync('${RAN_MARKER_FILE}', '${label}\\n');`,
    // Both units feed 2 through the shared source and on into server/logic.mjs,
    // so each one's result depends on code the suite then breaks to prove this
    // recorder really would have seen it.
    `  assert.equal(${fn}(1), 7);`,
    '});',
    '',
  ].join('\n');

const source = (fn: string, expr: string) =>
  [
    "import { shared } from './shared.mjs';",
    `export function ${fn}(x) {`,
    `  return shared(${expr});`,
    '}',
    '',
  ].join('\n');

describeAdapterConformance({
  adapter: genericAdapter,
  fixture: {
    command: ['node', '--test'],
    files: {
      'server/logic.mjs': 'export function price(qty) {\n  return qty * 3 + 1;\n}\n',
      'src/shared.mjs':
        "import { price } from '../server/logic.mjs';\n" +
        'export function shared(x) {\n  return price(x);\n}\n',
      'src/a.mjs': source('alpha', 'x * 2'),
      'src/b.mjs': source('beta', 'x + 1'),
      'test/a.test.mjs': test('test/a.test.mjs', 'src/a.mjs', 'alpha'),
      'test/b.test.mjs': test('test/b.test.mjs', 'src/b.mjs', 'beta'),
    },
    units: {
      a: {
        testFile: 'test/a.test.mjs',
        source: 'src/a.mjs',
        bodyEdit: { find: 'shared(x * 2)', replace: 'shared(x * 3)' },
      },
      b: {
        testFile: 'test/b.test.mjs',
        source: 'src/b.mjs',
        bodyEdit: { find: 'shared(x + 1)', replace: 'shared(x + 2)' },
      },
    },
    sharedSource: 'src/shared.mjs',
    blindSpot: {
      source: 'server/logic.mjs',
      breakingEdit: { find: 'qty * 3 + 1', replace: 'qty * 9 + 1' },
    },
    newTest: {
      file: 'test/c.test.mjs',
      contents: "import { test } from 'node:test';\ntest('c', () => {});\n",
    },
  },
});
