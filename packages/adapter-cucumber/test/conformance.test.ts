import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';

import { describeAdapterConformance } from '@covsel/conformance/vitest';

import {
  createCucumberRecorder,
  CUCUMBER_TEST_GLOBS,
  cucumberAdapter,
} from '../src/index.js';

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

describeAdapterConformance({
  adapter: cucumberAdapter,
  createRecorder: ({ cwd, config }) =>
    createCucumberRecorder({ command: [cucumberBin], cwd, config }),
  fixture: {
    command: [cucumberBin],
    nodeModulesFrom: exampleModules,
    config: { testGlobs: CUCUMBER_TEST_GLOBS },
    files: {
      'src/a.mjs': 'export function alpha(x) {\n  return x * 2;\n}\n',
      'src/b.mjs': 'export function beta(x) {\n  return x + 1;\n}\n',
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
        "import { When } from '@cucumber/cucumber';",
        "import { alpha } from '../src/a.mjs';",
        "import { beta } from '../src/b.mjs';",
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
      },
      b: {
        testFile: 'features/demo.feature',
        name: 'beta scenario',
        source: 'src/b.mjs',
      },
    },
    newTest: {
      file: 'features/later.feature',
      contents: 'Feature: later\n\n  Scenario: later scenario\n    When I run alpha\n',
    },
  },
});
