import { createGenericRecorder } from '@covsel/core';
import { describeAdapterConformance } from '@covsel/conformance/vitest';

import { genericAdapter } from '../src/index.js';

const test = (source: string, fn: string) =>
  [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    `import { ${fn} } from '../${source}';`,
    `test('${fn}', () => assert.equal(typeof ${fn}(1), 'number'));`,
    '',
  ].join('\n');

describeAdapterConformance({
  adapter: genericAdapter,
  createRecorder: ({ cwd, config }) =>
    createGenericRecorder({ command: ['node', '--test'], cwd, config }),
  fixture: {
    command: ['node', '--test'],
    files: {
      'src/a.mjs': 'export function alpha(x) {\n  return x * 2;\n}\n',
      'src/b.mjs': 'export function beta(x) {\n  return x + 1;\n}\n',
      'test/a.test.mjs': test('src/a.mjs', 'alpha'),
      'test/b.test.mjs': test('src/b.mjs', 'beta'),
    },
    units: {
      a: { testFile: 'test/a.test.mjs', source: 'src/a.mjs' },
      b: { testFile: 'test/b.test.mjs', source: 'src/b.mjs' },
    },
    newTest: {
      file: 'test/c.test.mjs',
      contents: "import { test } from 'node:test';\ntest('c', () => {});\n",
    },
  },
});
