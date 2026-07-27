import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';

import { describeAdapterConformance } from '@covsel/conformance/vitest';

import { createNodeTestRecorder, nodeTestAdapter } from '../src/index.js';

/**
 * The per-test case: both units live in one test file and are told apart by
 * name, so the suite's precision checks exercise scenario-level selection
 * rather than file-level. The recorder spawns a shim that imports the built
 * core, so this suite needs `@covsel/core` built.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));

beforeAll(() => {
  if (!existsSync(coreDist)) {
    execSync('pnpm --filter @covsel/core build', { cwd: repoRoot, stdio: 'ignore' });
  }
}, 120_000);

describeAdapterConformance({
  adapter: nodeTestAdapter,
  createRecorder: ({ cwd, config }) =>
    createNodeTestRecorder({ command: ['node', '--test'], cwd, config }),
  fixture: {
    command: ['node', '--test'],
    files: {
      'src/a.mjs': 'export function alpha(x) {\n  return x * 2;\n}\n',
      'src/b.mjs': 'export function beta(x) {\n  return x + 1;\n}\n',
      'suite.test.mjs': [
        "import { test } from 'node:test';",
        "import { alpha } from './src/a.mjs';",
        "import { beta } from './src/b.mjs';",
        "test('alpha test', () => { alpha(1); });",
        "test('beta test', () => { beta(1); });",
        '',
      ].join('\n'),
    },
    units: {
      a: { testFile: 'suite.test.mjs', name: 'alpha test', source: 'src/a.mjs' },
      b: { testFile: 'suite.test.mjs', name: 'beta test', source: 'src/b.mjs' },
    },
    newTest: {
      file: 'later.test.mjs',
      contents: "import { test } from 'node:test';\ntest('later', () => {});\n",
    },
  },
});
