import { afterAll, describe } from 'vitest';

import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

import { harnessAdapter } from '../src/index.js';
import { files, OBSERVES } from './fixture-app.js';
import { stopFixtureServer, withFixtureServer } from './server-lifecycle.js';

afterAll(() => {
  stopFixtureServer();
});

/**
 * Conformance for both recording modes, over one application: a Node script
 * plays the harness, an HTTP server plays the application, and a child
 * process it shells out to is the fixture's blind spot -- see
 * `fixture-app.ts` for why a real cross-language example lives under
 * `examples/harness-basic` instead.
 *
 * The suite never starts or stops the application server itself, exactly as
 * this adapter does not; `withFixtureServer` supplies what a real project's
 * CI would.
 */

const adapter = withFixtureServer(harnessAdapter);

const common = {
  command: ['node', 'harness.mjs'],
  units: {
    a: {
      testFile: 'tests/alpha.harness',
      source: 'src/a.mjs',
      bodyEdit: { find: 'x * 2', replace: 'x * 3' },
    },
    b: {
      testFile: 'tests/beta.harness',
      source: 'src/b.mjs',
      bodyEdit: { find: 'x + 1', replace: 'x + 2' },
    },
  },
  sharedSource: 'src/shared.mjs',
  blindSpot: {
    source: 'jobs/compute.mjs',
    breakingEdit: { find: 'qty * 3 + 1', replace: 'qty * 9 + 1' },
  },
  newTest: { file: 'tests/gamma.harness', contents: '# covers /gamma\n' },
};

describe('recording one invocation per test', () => {
  describeAdapterConformance(
    {
      adapter,
      fixture: {
        ...common,
        config: {
          testGlobs: ['tests/**/*.harness'],
          harness: { run: '--only {id}', server: { observes: OBSERVES } },
        },
        files: files({ markerFile: RAN_MARKER_FILE }),
      },
    },
    // Every check records at least once, and each recording boots a fresh
    // instance of the fixture's application server -- the same reason
    // Playwright's own conformance registrations use a generous timeout.
    { timeout: 240_000 },
  );
});

describe('recording one invocation, through the boundary protocol', () => {
  describeAdapterConformance(
    {
      adapter,
      fixture: {
        ...common,
        config: {
          testGlobs: ['tests/**/*.harness'],
          harness: {
            run: '--only {id}',
            server: { observes: OBSERVES },
            boundary: {},
          },
        },
        files: files({ markerFile: RAN_MARKER_FILE }),
      },
    },
    { timeout: 240_000 },
  );
});
