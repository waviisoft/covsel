import { fileURLToPath } from 'node:url';

import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import { jestAdapter } from '../src/index.js';

/**
 * The transformed-sources case: Jest compiles sources through its transformer
 * and evaluates them from its own module registry, so this proves the adapter's
 * coverage path attributes them back to the originals — including the shared
 * source, which no test file names and which is only reachable by following an
 * import through the unit's own source.
 * Jest is not a dependency of this package, so the fixture borrows the installed
 * copies from the jest example.
 */
const exampleModules = fileURLToPath(
  new URL('../../../examples/jest-basic/node_modules', import.meta.url),
);
const jestBin = fileURLToPath(
  new URL('../../../examples/jest-basic/node_modules/.bin/jest', import.meta.url),
);

/**
 * The suite writes the fixture's package.json as `"type": "module"`, and it has
 * no `@types` visible to a throwaway tsconfig, so the transform emits CommonJS
 * and skips type checking. Neither affects what Jest instruments.
 */
const jestConfig = [
  'export default {',
  "  testEnvironment: 'node',",
  "  testMatch: ['<rootDir>/test/**/*.test.ts'],",
  "  moduleNameMapper: { '^(\\\\.{1,2}/.*)\\\\.js$': '$1' },",
  '  transform: {',
  "    '^.+\\\\.ts$': [",
  "      'ts-jest',",
  '      {',
  '        diagnostics: false,',
  "        tsconfig: { target: 'ES2022', module: 'CommonJS', esModuleInterop: true },",
  '      },',
  '    ],',
  '  },',
  '};',
  '',
].join('\n');

const suite = (label: string, source: string, fn: string) =>
  [
    "import { appendFileSync } from 'node:fs';",
    `import { ${fn} } from '../${source.replace(/\.ts$/, '.js')}';`,
    `test('${fn}', () => {`,
    `  appendFileSync('${RAN_MARKER_FILE}', '${label}\\n');`,
    // Both units feed 2 through the shared source and on into server/logic.ts,
    // so each one's result depends on code the suite then breaks to prove this
    // recorder really would have seen it.
    `  expect(${fn}(1)).toBe(7);`,
    '});',
    '',
  ].join('\n');

const source = (fn: string, expr: string) =>
  [
    "import { shared } from './shared.js';",
    `export function ${fn}(x: number): number {`,
    `  return shared(${expr});`,
    '}',
    '',
  ].join('\n');

describeAdapterConformance({
  adapter: jestAdapter,
  fixture: {
    command: [jestBin],
    nodeModulesFrom: exampleModules,
    files: {
      'jest.config.mjs': jestConfig,
      'server/logic.ts':
        'export function price(qty: number): number {\n  return qty * 3 + 1;\n}\n',
      'src/shared.ts':
        "import { price } from '../server/logic.js';\n" +
        'export function shared(x: number): number {\n  return price(x);\n}\n',
      'src/a.ts': source('alpha', 'x * 2'),
      'src/b.ts': source('beta', 'x + 1'),
      'test/a.test.ts': suite('test/a.test.ts', 'src/a.ts', 'alpha'),
      'test/b.test.ts': suite('test/b.test.ts', 'src/b.ts', 'beta'),
    },
    units: {
      a: {
        testFile: 'test/a.test.ts',
        source: 'src/a.ts',
        bodyEdit: { find: 'shared(x * 2)', replace: 'shared(x * 3)' },
      },
      b: {
        testFile: 'test/b.test.ts',
        source: 'src/b.ts',
        bodyEdit: { find: 'shared(x + 1)', replace: 'shared(x + 2)' },
      },
    },
    sharedSource: 'src/shared.ts',
    blindSpot: {
      source: 'server/logic.ts',
      breakingEdit: { find: 'qty * 3 + 1', replace: 'qty * 9 + 1' },
    },
    newTest: {
      file: 'test/c.test.ts',
      contents: "test('c', () => {\n  expect(1).toBe(1);\n});\n",
    },
  },
});
