import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe } from 'vitest';

import type { ConformanceFixture } from '@covsel/conformance';
import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import { playwrightAdapter } from '../src/index.js';
import { BROWSER_OBSERVES, files, SERVER_OBSERVES, spec } from './fixture-app.js';

/**
 * Per-test conformance for an adapter that watches something other than the
 * process covsel started.
 *
 * This is the first adapter the suite certifies that cannot see the whole test,
 * and two things follow. It needs a real application, served over HTTP, because
 * an `http://` script resolved through a source map is the only thing this
 * recorder ever sees — a fixture of plain files on disk would exercise a path the
 * adapter does not take. And it needs a `blindSpot`, because it declares less
 * than the whole repository and the suite has to hold that declaration to code
 * both units execute and the recording cannot see.
 *
 * Run twice, over one application, differing only in what the project told covsel
 * to watch:
 *
 *  - **the browser alone**, which is what a project gets with no configuration
 *    beyond `observes`. The server is then the blind spot, and a change to it has
 *    to fall open.
 *  - **the browser and the server**, over Node's inspector. The server is then
 *    observed, and the suite checks the other direction: that a recorder claiming
 *    that ground really recorded it. The blind spot moves to the work the server
 *    hands to a second process, which no repo-path scope can describe and neither
 *    window can see.
 *
 * Excluded from `pnpm test` and run by `pnpm test:browser`, because both need
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

/** Everything the two runs share: the same application, driven the same way. */
const common = {
  command: [playwrightBin, 'test'],
  nodeModulesFrom: exampleModules,
  units: {
    a: {
      testFile: 'tests/demo.spec.js',
      // The title path as Playwright greps it, less the project name — which is
      // what the recorder writes and what a selection has to name.
      name: 'demo.spec.js the app alpha test',
      source: 'src/a.js',
      bodyEdit: { find: 'shared(x * 2)', replace: 'shared(x * 4)' },
    },
    b: {
      testFile: 'tests/demo.spec.js',
      name: 'demo.spec.js the app beta test',
      source: 'src/b.js',
      bodyEdit: { find: 'shared(x + 1)', replace: 'shared(x + 3)' },
    },
  },
  sharedSource: 'src/shared.js',
  newTest: {
    file: 'tests/later.spec.js',
    contents: spec(RAN_MARKER_FILE, [
      { title: 'later test', button: 'alpha', expected: '108' },
    ]),
  },
} satisfies Omit<ConformanceFixture, 'files' | 'config' | 'blindSpot'>;

describe('watching the browser alone', () => {
  describeAdapterConformance(
    {
      adapter: playwrightAdapter,
      fixture: {
        ...common,
        // No default is available and none would be right: `**` would claim the
        // browser watched the server, and a change under `server/` would then
        // read as touching code no test covers.
        config: { observes: BROWSER_OBSERVES },
        files: files({ markerFile: RAN_MARKER_FILE }),
        blindSpot: {
          // Every price the units assert on is computed here, and the browser
          // never runs a line of it.
          source: 'server/pricing.mjs',
          breakingEdit: { find: 'String(qty)', replace: 'String(qty + 1)' },
        },
      },
    },
    // Every check records at least once, and a recording boots a browser and
    // the application behind it.
    { timeout: 240_000 },
  );
});

describe('watching the browser and the server it drives', () => {
  describeAdapterConformance(
    {
      adapter: playwrightAdapter,
      fixture: {
        ...common,
        config: { observes: [...BROWSER_OBSERVES, ...SERVER_OBSERVES] },
        files: files({ markerFile: RAN_MARKER_FILE, server: true }),
        blindSpot: {
          // The server hands this work to a process it starts, and the inspector
          // session watches the server, not its children. Paths say where in the
          // repository code lives, never which process ran it — so this is the
          // one boundary the declaration cannot describe, and the one the suite
          // has to see fall open.
          source: 'jobs/compute.mjs',
          breakingEdit: { find: 'qty * 3 + 1', replace: 'qty * 9 + 1' },
        },
      },
    },
    { timeout: 240_000 },
  );
});
