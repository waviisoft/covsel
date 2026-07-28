import { createGenericRecorder } from '@covsel/core';
import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import { genericAdapter } from '../src/index.js';

const test = (label: string, source: string, fn: string) =>
  [
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `import { ${fn} } from '../${source}';`,
    "import { shared } from '../src/shared.mjs';",
    `test('${fn}', () => {`,
    `  appendFileSync('${RAN_MARKER_FILE}', '${label}\\n');`,
    `  assert.equal(typeof shared(${fn}(1)), 'number');`,
    '});',
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
      'src/a.mjs': 'export function alpha(x) {\n  return x * 2;\n}\n',
      'src/b.mjs': 'export function beta(x) {\n  return x + 1;\n}\n',
      'test/a.test.mjs': test('test/a.test.mjs', 'src/a.mjs', 'alpha'),
      'test/b.test.mjs': test('test/b.test.mjs', 'src/b.mjs', 'beta'),
    },
    units: {
      a: { testFile: 'test/a.test.mjs', source: 'src/a.mjs' },
      b: { testFile: 'test/b.test.mjs', source: 'src/b.mjs' },
    },
    sharedSource: 'src/shared.mjs',
    newTest: {
      file: 'test/c.test.mjs',
      contents: "import { test } from 'node:test';\ntest('c', () => {});\n",
    },
  },
});
