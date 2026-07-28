import { fileURLToPath } from 'node:url';

import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import { createVitestRecorder, vitestAdapter } from '../src/index.js';

/**
 * The transformed-sources case: Vitest evaluates sources through its own module
 * runner, so this proves the adapter's coverage path attributes them correctly.
 * Vitest and its coverage provider are not dependencies of this package, so the
 * fixture borrows the installed copies from the vitest example.
 */
const exampleModules = fileURLToPath(
  new URL('../../../examples/vitest-basic/node_modules', import.meta.url),
);
const vitestBin = fileURLToPath(
  new URL('../../../examples/vitest-basic/node_modules/.bin/vitest', import.meta.url),
);

const suite = (label: string, source: string, fn: string) =>
  [
    "import { appendFileSync } from 'node:fs';",
    "import { expect, test } from 'vitest';",
    `import { ${fn} } from '../${source.replace(/\.ts$/, '.js')}';`,
    "import { shared } from '../src/shared.js';",
    `test('${fn}', () => {`,
    `  appendFileSync('${RAN_MARKER_FILE}', '${label}\\n');`,
    `  expect(typeof shared(${fn}(1))).toBe('number');`,
    '});',
    '',
  ].join('\n');

describeAdapterConformance({
  adapter: vitestAdapter,
  createRecorder: ({ cwd, config }) =>
    createVitestRecorder({ command: [vitestBin, 'run'], cwd, config }),
  fixture: {
    command: [vitestBin, 'run'],
    nodeModulesFrom: exampleModules,
    files: {
      'vitest.config.ts':
        "import { defineConfig } from 'vitest/config';\n" +
        "export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n",
      'src/shared.ts':
        'export function shared(x: number): number {\n  return x + 0;\n}\n',
      'src/a.ts': 'export function alpha(x: number): number {\n  return x * 2;\n}\n',
      'src/b.ts': 'export function beta(x: number): number {\n  return x + 1;\n}\n',
      'test/a.test.ts': suite('test/a.test.ts', 'src/a.ts', 'alpha'),
      'test/b.test.ts': suite('test/b.test.ts', 'src/b.ts', 'beta'),
    },
    units: {
      a: { testFile: 'test/a.test.ts', source: 'src/a.ts' },
      b: { testFile: 'test/b.test.ts', source: 'src/b.ts' },
    },
    sharedSource: 'src/shared.ts',
    newTest: {
      file: 'test/c.test.ts',
      contents:
        "import { expect, test } from 'vitest';\ntest('c', () => expect(1).toBe(1));\n",
    },
  },
});
