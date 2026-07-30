import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';

import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import { mochaAdapter } from '../src/index.js';

/**
 * The per-test case: both units live in one spec file and are told apart by
 * their full title, so the suite's precision checks exercise per-test selection
 * rather than file-level, and `runSelection` proves the `--grep` filter really
 * narrows the run. Mocha is not a dependency of this package, so the fixture
 * borrows the installed copy from the Mocha example; the recorder spawns a shim
 * that imports the built core, so this suite needs `@covsel/core` built.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const exampleModules = fileURLToPath(
  new URL('../../../examples/mocha-basic/node_modules', import.meta.url),
);
const mochaBin = fileURLToPath(
  new URL('../../../examples/mocha-basic/node_modules/.bin/mocha', import.meta.url),
);

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

const unit = (title: string, fn: string) =>
  [
    `  it('${title}', () => {`,
    `    appendFileSync('${RAN_MARKER_FILE}', '${title}\\n');`,
    // Both units feed 2 through the shared source and on into server/logic.mjs,
    // so each one's result depends on code the suite then breaks to prove this
    // recorder really would have seen it.
    `    assert.equal(${fn}(1), 7);`,
    '  });',
  ].join('\n');

describeAdapterConformance({
  adapter: mochaAdapter,
  fixture: {
    command: [mochaBin],
    nodeModulesFrom: exampleModules,
    files: {
      'server/logic.mjs': 'export function price(qty) {\n  return qty * 3 + 1;\n}\n',
      'src/shared.mjs':
        "import { price } from '../server/logic.mjs';\n" +
        'export function shared(x) {\n  return price(x);\n}\n',
      'src/a.mjs': source('alpha', 'x * 2'),
      'src/b.mjs': source('beta', 'x + 1'),
      'test/suite.test.mjs': [
        "import assert from 'node:assert/strict';",
        "import { appendFileSync } from 'node:fs';",
        "import { alpha } from '../src/a.mjs';",
        "import { beta } from '../src/b.mjs';",
        unit('alpha test', 'alpha'),
        unit('beta test', 'beta'),
        '',
      ].join('\n'),
    },
    units: {
      a: {
        testFile: 'test/suite.test.mjs',
        name: 'alpha test',
        source: 'src/a.mjs',
        bodyEdit: { find: 'shared(x * 2)', replace: 'shared(x * 3)' },
      },
      b: {
        testFile: 'test/suite.test.mjs',
        name: 'beta test',
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
      file: 'test/later.test.mjs',
      contents: "describe('later', () => {\n  it('runs', () => {});\n});\n",
    },
  },
});
