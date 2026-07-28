import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';

import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import {
  createNodeTestRecorder,
  nodeTestAdapter,
  runNodeTestSelection,
} from '../src/index.js';

/**
 * The per-test case: both units live in one test file and are told apart by
 * name, so the suite's precision checks exercise per-test selection rather than
 * file-level, and `runSelection` proves the name filter really narrows the run.
 * The recorder spawns a shim that imports the built core, so this suite needs
 * `@covsel/core` built.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));

beforeAll(() => {
  if (!existsSync(coreDist)) {
    execSync('pnpm --filter @covsel/core build', { cwd: repoRoot, stdio: 'ignore' });
  }
}, 120_000);

const source = (fn: string, expr: string) =>
  [
    "import { shared } from './shared.mjs';",
    `export function ${fn}(x) {`,
    `  return shared(${expr});`,
    '}',
    '',
  ].join('\n');

const unit = (name: string, fn: string) =>
  [
    `test('${name}', () => {`,
    `  appendFileSync('${RAN_MARKER_FILE}', '${name}\\n');`,
    `  ${fn}(1);`,
    '});',
  ].join('\n');

describeAdapterConformance({
  adapter: nodeTestAdapter,
  createRecorder: ({ cwd, config }) =>
    createNodeTestRecorder({ command: ['node', '--test'], cwd, config }),
  runSelection: ({ selected, cwd }) =>
    runNodeTestSelection({ command: ['node', '--test'], selected, cwd, stdio: 'ignore' }),
  fixture: {
    command: ['node', '--test'],
    files: {
      'src/shared.mjs': 'export function shared(x) {\n  return x + 0;\n}\n',
      'src/a.mjs': source('alpha', 'x * 2'),
      'src/b.mjs': source('beta', 'x + 1'),
      'suite.test.mjs': [
        "import { appendFileSync } from 'node:fs';",
        "import { test } from 'node:test';",
        "import { alpha } from './src/a.mjs';",
        "import { beta } from './src/b.mjs';",
        unit('alpha test', 'alpha'),
        unit('beta test', 'beta'),
        '',
      ].join('\n'),
    },
    units: {
      a: {
        testFile: 'suite.test.mjs',
        name: 'alpha test',
        source: 'src/a.mjs',
        bodyEdit: { find: 'shared(x * 2)', replace: 'shared(x * 3)' },
      },
      b: {
        testFile: 'suite.test.mjs',
        name: 'beta test',
        source: 'src/b.mjs',
        bodyEdit: { find: 'shared(x + 1)', replace: 'shared(x + 2)' },
      },
    },
    sharedSource: 'src/shared.mjs',
    newTest: {
      file: 'later.test.mjs',
      contents: "import { test } from 'node:test';\ntest('later', () => {});\n",
    },
  },
});
