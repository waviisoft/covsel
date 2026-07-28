import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';

import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import { cucumberAdapter } from '../src/index.js';

/**
 * Scenario-level conformance: two scenarios in one feature file execute
 * different sources. cucumber-js is not a dependency of this package, so the
 * fixture borrows the installed copy from the cucumber example.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const exampleModules = fileURLToPath(
  new URL('../../../examples/cucumber-basic/node_modules', import.meta.url),
);
const cucumberBin = fileURLToPath(
  new URL(
    '../../../examples/cucumber-basic/node_modules/.bin/cucumber-js',
    import.meta.url,
  ),
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

describeAdapterConformance({
  adapter: cucumberAdapter,
  fixture: {
    command: [cucumberBin],
    nodeModulesFrom: exampleModules,
    files: {
      'src/shared.mjs': 'export function shared(x) {\n  return x + 0;\n}\n',
      'src/a.mjs': source('alpha', 'x * 2'),
      'src/b.mjs': source('beta', 'x + 1'),
      'features/demo.feature': [
        'Feature: demo',
        '',
        '  Scenario: alpha scenario',
        '    When I run alpha',
        '',
        '  Scenario: beta scenario',
        '    When I run beta',
        '',
      ].join('\n'),
      'features/steps.mjs': [
        "import { appendFileSync } from 'node:fs';",
        "import { Before, When } from '@cucumber/cucumber';",
        "import { alpha } from '../src/a.mjs';",
        "import { beta } from '../src/b.mjs';",
        // The scenario name is only on the pickle, so the marker is written from
        // a hook rather than from the steps, which several scenarios share.
        `Before(function ({ pickle }) { appendFileSync('${RAN_MARKER_FILE}', pickle.name + '\\n'); });`,
        "When('I run alpha', function () { alpha(1); });",
        "When('I run beta', function () { beta(1); });",
        '',
      ].join('\n'),
    },
    units: {
      a: {
        testFile: 'features/demo.feature',
        name: 'alpha scenario',
        source: 'src/a.mjs',
        bodyEdit: { find: 'shared(x * 2)', replace: 'shared(x * 3)' },
      },
      b: {
        testFile: 'features/demo.feature',
        name: 'beta scenario',
        source: 'src/b.mjs',
        bodyEdit: { find: 'shared(x + 1)', replace: 'shared(x + 2)' },
      },
    },
    sharedSource: 'src/shared.mjs',
    newTest: {
      file: 'features/later.feature',
      contents: 'Feature: later\n\n  Scenario: later scenario\n    When I run alpha\n',
    },
  },
});
