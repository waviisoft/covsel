# @covsel/adapter-playwright

## 0.1.0

### Minor Changes

- 8d54ff3: Add `@covsel/adapter-playwright`: per-test selection for Playwright, recorded
  from what each test executed **in the browser**.

  E2E minutes are the most expensive minutes in CI, and static selection cannot
  help — Playwright's own `--only-changed` walks the import graph of the spec
  files, which cannot see through the HTTP boundary to know which application code
  a spec exercises. This records what does run there.

  Recording is one `playwright test` invocation, so the `webServer` boots once. An
  auto-fixture the project installs on its own `test` object collects Chromium's V8
  coverage around each test and projects it back through the application's source
  maps, in the Playwright worker — where a dev server's modules are still
  reachable. `covsel run` hands Playwright the affected spec files narrowed by
  `--grep`.

  It observes the browser and nothing else, and says so: the project declares
  `observes`, that scope is stamped into the map, and every change outside it
  forces a full run rather than being read as code no test covers. A server change
  falls open; a click handler change selects the one test that ran it.

  Supporting changes in `@covsel/core`:

  - **`observes` in the project's configuration.** Which repo paths reach a browser
    depends on the build layout and where the server lives, neither of which an
    adapter can infer, so the project states it. Most recorders work it out for
    themselves and ignore this; one that cannot refuses to record without it,
    because both defaults are wrong — `**` skips tests, nothing at all turns every
    recording into a full run.
  - **`testNameSuffixPattern`.** Playwright matches `--grep` against a title it has
    prefixed with the project name, so a pattern anchored at the front would name
    one browser and select nothing at all under the others.
  - **A source named relative to the script that was served now resolves.** Vite
    and its family answer `/src/cart.ts` with a map naming `cart.ts`; read against
    the repo root alone that source is looked for at the top of the tree and
    reported as coverage the recording could not locate, which fails every
    dev-server recording. The URL's own directory is now tried first, still
    confirmed against the text the build published.
  - **`covsel init` names the Playwright adapter** for a project that has
    `@playwright/test`, and names Cypress as a runner no adapter records yet.

  The adapter also observes the **application server** when the project asks it
  to, so a change there selects the tests that reached it instead of falling open:

  ```ts
  export const test = base.extend(
    covselFixtures({
      browser: { observes: ['src/**'] },
      server: { observes: ['server/**'], inspectUrl: 'http://127.0.0.1:9229' },
    }),
  );
  ```

  It opens a Node inspector session per test against the server Playwright already
  started — nothing of covsel runs inside it — and each window declares what it
  alone could see, so a browser recording never vouches for the server. Recording
  needs `--workers=1` when the server window is on, and the fixture refuses rather
  than credit one worker's server execution to another's test. The server window
  tells covsel less than the browser window does: coverage starts when the test
  does, so a module the server loaded at boot reports only the functions that ran
  and covsel reads the rest as executed — file granularity, fail-open. A module
  first imported during the test keeps real block granularity.

  Both configurations run the shared conformance suite, against a real browser and
  a served application, in their own CI job.

### Patch Changes

- Updated dependencies [c9d768d]
- Updated dependencies [88a7f54]
- Updated dependencies [dcb274c]
- Updated dependencies [6b05505]
- Updated dependencies [6e1c58d]
- Updated dependencies [b1b7798]
- Updated dependencies [bef646c]
- Updated dependencies [a5cec27]
- Updated dependencies [1281329]
- Updated dependencies [1281329]
- Updated dependencies [8e1cff2]
- Updated dependencies [ded16be]
- Updated dependencies [8f8a6d4]
- Updated dependencies [f068792]
- Updated dependencies [181135e]
- Updated dependencies [7b3e9f3]
- Updated dependencies [7e034a9]
- Updated dependencies [9357ecf]
- Updated dependencies [70f12a5]
- Updated dependencies [b00c7cb]
- Updated dependencies [e406004]
- Updated dependencies [1281329]
- Updated dependencies [89a25dc]
- Updated dependencies [3cc55e7]
- Updated dependencies [859ff72]
- Updated dependencies [dbaf1b5]
- Updated dependencies [9241c52]
- Updated dependencies [94f8d85]
- Updated dependencies [505db55]
- Updated dependencies [a9bbe19]
- Updated dependencies [7886f0b]
- Updated dependencies [049ee96]
- Updated dependencies [8d54ff3]
- Updated dependencies [7a64bfc]
- Updated dependencies [6071216]
- Updated dependencies [47044db]
- Updated dependencies [6e777ed]
- Updated dependencies [6c318cc]
- Updated dependencies [861ce05]
- Updated dependencies [5507f29]
- Updated dependencies [505db55]
- Updated dependencies [6020222]
- Updated dependencies [538db8f]
- Updated dependencies [76df431]
- Updated dependencies [1281329]
  - @covsel/core@0.1.0
