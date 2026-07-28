import { createGenericRecorder } from '@covsel/core';
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
    `  assert.equal(typeof ${fn}(1), 'number');`,
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
  createRecorder: ({ cwd, config }) =>
    createGenericRecorder({ command: ['node', '--test'], cwd, config }),
  fixture: {
    command: ['node', '--test'],
    files: {
      'src/shared.mjs': 'export function shared(x) {\n  return x + 0;\n}\n',
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
    newTest: {
      file: 'test/c.test.mjs',
      contents: "import { test } from 'node:test';\ntest('c', () => {});\n",
    },
  },
});
