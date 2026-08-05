import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';

import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import { playwrightAdapter } from '../src/index.js';
import {
  A,
  B,
  FIXTURES,
  INDEX_HTML,
  LOGIC,
  MAIN,
  playwrightConfig,
  SERVER,
  SHARED,
  spec,
} from './fixture-app.js';

/**
 * Per-test conformance for an adapter that watches a browser.
 *
 * This is the first adapter the suite certifies that cannot see the whole test.
 * Two things follow. It needs a real application, served over HTTP, because an
 * `http://` script resolved through a source map is the only thing this recorder
 * ever sees — a fixture of plain files on disk would exercise a path the adapter
 * does not take. And it needs a `blindSpot`: the adapter declares `src/**` and
 * nothing else, so the suite has to hold that declaration to something, which
 * means code both units depend on and the browser never runs.
 *
 * `server/logic.mjs` is both. Every assertion here is a number the server
 * computed and a unit's own source transformed, so breaking the server breaks
 * both units — and a recording that quietly credited itself with having watched
 * it would be caught.
 *
 * Excluded from `pnpm test` and run by `pnpm test:browser`, because it needs
 * Chromium.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url));
const adapterDist = fileURLToPath(new URL('../dist/fixture.js', import.meta.url));
// The example's install, so the runner and the `@playwright/test` the specs
// import are one copy. Two copies is a supported way to get "Playwright Test did
// not expect test.beforeEach() to be called here".
const exampleModules = fileURLToPath(
  new URL('../../../examples/playwright-basic/node_modules', import.meta.url),
);
const playwrightBin = fileURLToPath(
  new URL(
    '../../../examples/playwright-basic/node_modules/.bin/playwright',
    import.meta.url,
  ),
);

beforeAll(() => {
  // The fixture's specs import the adapter by specifier, which resolves to its
  // build. Recording against a stale one would certify code nobody is shipping.
  for (const [dist, filter] of [
    [coreDist, '@covsel/core'],
    [adapterDist, '@covsel/adapter-playwright'],
  ] as const) {
    if (!existsSync(dist)) {
      execSync(`pnpm --filter ${filter} build`, { cwd: repoRoot, stdio: 'ignore' });
    }
  }
}, 180_000);

describeAdapterConformance(
  {
    adapter: playwrightAdapter,
    fixture: {
      command: [playwrightBin, 'test'],
      nodeModulesFrom: exampleModules,
      config: {
        // No default is available and none would be right: `**` would claim the
        // browser watched the server, and a change to `server/logic.mjs` would
        // then read as touching code no test covers.
        observes: ['src/**'],
      },
      files: {
        'index.html': INDEX_HTML,
        'playwright.config.js': playwrightConfig(),
        'server/serve.mjs': SERVER,
        'server/logic.mjs': LOGIC,
        'src/shared.js': SHARED,
        'src/a.js': A,
        'src/b.js': B,
        'src/main.js': MAIN,
        'tests/fixtures.js': FIXTURES,
        'tests/demo.spec.js': spec(RAN_MARKER_FILE, [
          // price(1) is 4; alpha doubles it and shared adds 100.
          { title: 'alpha test', button: 'alpha', expected: '108' },
          { title: 'beta test', button: 'beta', expected: '105' },
        ]),
      },
      units: {
        a: {
          testFile: 'tests/demo.spec.js',
          // The title path as Playwright greps it, less the project name — which
          // is what the recorder writes and what a selection has to name.
          name: 'demo.spec.js alpha test',
          source: 'src/a.js',
          bodyEdit: { find: 'shared(x * 2)', replace: 'shared(x * 4)' },
        },
        b: {
          testFile: 'tests/demo.spec.js',
          name: 'demo.spec.js beta test',
          source: 'src/b.js',
          bodyEdit: { find: 'shared(x + 1)', replace: 'shared(x + 3)' },
        },
      },
      sharedSource: 'src/shared.js',
      blindSpot: {
        source: 'server/logic.mjs',
        breakingEdit: { find: 'qty * 3 + 1', replace: 'qty * 9 + 1' },
      },
      newTest: {
        file: 'tests/later.spec.js',
        contents: spec(RAN_MARKER_FILE, [
          { title: 'later test', button: 'alpha', expected: '108' },
        ]),
      },
    },
  },
  // Every check records at least once, and a recording boots a browser and the
  // application behind it.
  { timeout: 240_000 },
);
