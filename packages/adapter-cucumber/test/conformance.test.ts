import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';

import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import {
  createCucumberRecorder,
  CUCUMBER_TEST_GLOBS,
  cucumberAdapter,
  runCucumberSelection,
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
  runSelection: ({ selected, cwd }) =>
    runCucumberSelection({ command: [cucumberBin], selected, cwd, stdio: 'ignore' }),
  fixture: {
    command: [cucumberBin],
    nodeModulesFrom: exampleModules,
    config: { testGlobs: CUCUMBER_TEST_GLOBS },
    files: {
      'src/shared.mjs': 'export function shared(x) {\n  return x + 0;\n}\n',
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
        "import { appendFileSync } from 'node:fs';",
        "import { Before, When } from '@cucumber/cucumber';",
        "import { alpha } from '../src/a.mjs';",
        "import { beta } from '../src/b.mjs';",
        "import { shared } from '../src/shared.mjs';",
        // The scenario name is only on the pickle, so the marker is written from
        // a hook rather than from the steps, which several scenarios share.
        `Before(function ({ pickle }) { appendFileSync('${RAN_MARKER_FILE}', pickle.name + '\\n'); });`,
        "When('I run alpha', function () { shared(alpha(1)); });",
        "When('I run beta', function () { shared(beta(1)); });",
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
    sharedSource: 'src/shared.mjs',
    newTest: {
      file: 'features/later.feature',
      contents: 'Feature: later\n\n  Scenario: later scenario\n    When I run alpha\n',
    },
  },
});
