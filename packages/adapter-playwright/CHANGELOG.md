# @covsel/adapter-playwright

## 0.2.0

### Minor Changes

- 64d9b0c: Block-level server coverage, for a server started with `NODE_V8_COVERAGE`.

  The Playwright adapter's server window and `InspectorObserver` could only ever
  see block granularity for code a server loaded _during_ a test's own window.
  Anything imported at boot — which for a typical server is nearly every route
  and page module — kept only file granularity, because coverage collection
  started fresh with each test and had no way to tell an un-run function from
  one nobody had ever tracked.

  Start the server with `NODE_V8_COVERAGE` pointed at a directory (alongside
  `--inspect`, still), and pass the same directory as `coverageDir`:

  ```ts
  export const test = base.extend(
    covselFixtures({
      browser: { observes: ['src/**'] },
      server: {
        observes: ['server/**'],
        inspectUrl: 'http://127.0.0.1:9229',
        coverageDir: '/abs/path/to/.covsel/server-cov',
      },
    }),
  );
  ```

  V8 then collects precise coverage from the moment the process starts, so the
  first dump — taken before the first test — sees every function boot loaded,
  including the ones that never ran, at a real zero count. That "boot" delta is
  merged into every later test's own delta, keeping block granularity for
  boot-loaded code the same way it already worked for code loaded on demand.
  Leaving `coverageDir` unset keeps today's behavior: a session opened fresh
  inside each test, file-granular for anything loaded at boot.

  `InspectorObserver` picks the same mechanism up automatically, from
  `process.env.NODE_V8_COVERAGE` on the process it is observing, with no
  config: set the env var on a `covsel record` invocation and it takes the boot
  dump before the first `startTest()` instead of diffing per-test CDP
  snapshots.

  A second recording can attach to a server an earlier one already booted —
  `reuseExistingServer: true`, a retried worker, one worker per project — and
  still get the same boot dump rather than mistaking its own first dump for a
  fresh boot: the server remembers, in its own memory, that it already booted
  and which dump proves it, so a later session reads that one back instead of
  capturing a partial delta and crediting it as if nothing had run before it.
  The coverage directory has to stay in place while a server is reused this
  way; a directory cleared between recordings disagrees with what the server
  remembers and fails the recording rather than silently rebooting.

  A dump this cannot attribute to the tracked process's own main thread alone —
  a worker thread or a child process that inherited `NODE_V8_COVERAGE`, or two
  overlapping windows — fails the recording rather than guessing which test it
  belongs to, the same standard the per-test session already held itself to.
  That only catches a worker or child that actually writes a dump during the
  recording, which a short-lived one does on exit; one that outlives the
  recording never does, so its own execution goes unrecorded rather than
  failing loudly — the same gap the fallback, and the per-test session before
  it, already had for anything outside the process being observed.

- 8d96eb6: Answer `covsel doctor` from Jest, Mocha, Cucumber and Playwright, not only Vitest.

  `covsel doctor` compares covsel's idea of the suite against the runner's own, and
  an adapter that cannot ask its runner leaves that check unmade — reported as
  `unavailable`, which is honest but is not a guard. Four more adapters can now
  answer, so four more projects get one:

  | Runner     | Asked with                  |
  | ---------- | --------------------------- |
  | Jest       | `--listTests --json`        |
  | Mocha      | `--dry-run --reporter json` |
  | Cucumber   | `--dry-run --format json`   |
  | Playwright | `--list --reporter=json`    |

  `node --test` still has no listing mode and the generic wrap still cannot know
  what it is wrapping, so both continue to omit the capability rather than guess.

  The handling every listing shares now lives in `@covsel/core` — the spawn and its
  timeout, the strict "this was not a listing" checks, the refusal to answer a
  command that narrows the run, and the normalisation to repo-relative POSIX paths.
  That handling is load-bearing rather than incidental: a listing that half-works is
  worse than one that fails, because a partial set compares against covsel's full
  discovery as drift and sends someone editing `testGlobs` over a question the
  runner was never asked. Getting it identically right in five hand-written places
  is how the five stop agreeing.

  Each runner keeps what is genuinely its own. Mocha and Cucumber have no list mode
  at all, so they answer from a dry run, which loads the files without executing
  the tests; Mocha's enumerates _tests_, so a spec file holding none is invisible to
  it — able to miss a file rather than invent one, which is the right way round.
  Playwright reports paths relative to its own `rootDir` and nests its suites one
  layer per project, so its specs are walked rather than read off the top level.

  `listTests` is now also checked by `assertAdapter`, alongside `runSelection`, so
  a third-party adapter shipping something that is not callable is rejected by name
  up front instead of failing at the call.

### Patch Changes

- 5a63880: Add `@covsel/adapter-harness`: selection for a test harness in any language that
  drives a Node application from outside -- over HTTP, a browser, an MCP client,
  anything -- recorded from the application server's own inspector.

  The test process is never Node, so neither the generic adapter's
  `NODE_V8_COVERAGE` wrap nor any per-runner adapter can see what a Python harness,
  a Go test binary, or a Gherkin runner in another language executes. This
  adapter records the application code such a harness exercises **on the
  server**, reusing the Playwright adapter's server-window mechanism --
  now shared from `@covsel/core` as `RemoteCoverageSession`, so a second adapter
  could reuse it without depending on another adapter, which this repo's own
  conventions forbid.

  Two ways to find test boundaries, both supported:

  - **One invocation per test.** covsel runs the harness once per discovered id,
    needing nothing from it. Slow -- every invocation pays the harness's own
    start-up cost -- but works for a harness nobody has touched.
  - **The boundary protocol, one invocation.** Set `harness.boundary`, and covsel
    starts an HTTP server, sets `COVSEL_BOUNDARY`, and spawns the harness's plain,
    unfiltered command. A cooperating harness posts `/begin` and `/end` around
    each test and waits for covsel's acknowledgement, so the full run CI already
    does can also be the recording -- the only way recording costs no extra
    runner-minutes. The protocol is documented as a spec any language can
    implement, with a reference client (`covsel_boundary.py`) in
    `examples/harness-basic`.

  covsel does not guess the harness's selection flag. `harness.run` names it as a
  template appended to the base command, with `{id}` (repeated once per selected
  test) or `{ids}` (one comma-joined token) marking where the id goes:

  ```json
  {
    "adapter": "harness",
    "harness": {
      "run": "--only {id}",
      "server": { "observes": ["src/server/**", "src/routes/**"] }
    }
  }
  ```

  An empty selection never runs the bare command -- core already refused that for
  every adapter, and this one's `runSelection` does too, since nothing stops a
  future caller from reaching it directly.

  Fail-open rules carry over unchanged: a test the run never reported, a red test,
  an unreachable inspector, or a boundary-protocol violation (two tests
  overlapping, an `end` naming a test that was not open) all fail the whole
  recording. A skipped test is recorded as covering nothing, never whatever the
  server happened to do during its window. A test that never reports `/end` --
  a stuck harness or application, not a slow test -- fails the recording after
  `harness.boundary.testTimeoutMs` (ten minutes by default) rather than hanging
  `covsel record` forever, and the watchdog now kills the harness's whole process
  group, not only its direct child, so a harness that is itself a shell wrapper
  or task runner cannot outlive it; per-test mode gets the same bound.

  Two documented limits: server work that finishes after the response it belongs
  to has already gone out is not attributed to any test unless the new, opt-in
  `harness.server.settleMs` gives it a little longer to happen inside the window
  -- a mitigation, not a guarantee, since covsel cannot detect such work from
  outside the harness. And `{ids}` mode cannot express an id containing a comma
  (it would be indistinguishable from separate ids once joined) -- `expand`
  refuses eagerly and points at `{id}` mode instead, which has no such limit.
  The boundary server also now requires a per-recording token (embedded in the
  URL it hands the harness) and a JSON content type on both endpoints, so a
  stray or forged request -- notably from a page a browser-driving harness loads,
  which needs no CORS preflight for a `text/plain` POST -- cannot corrupt a
  window's timing.

  The harness's own code (step definitions, page objects, a spec pinned from
  another repository) is not observed either, and a change there can change
  what a test does with no application change at all. `@covsel/core`'s new
  `inventory.command` (see its own changeset) gives that a narrower answer than
  a blanket sentinel: a command that reports each scenario's id and an opaque
  version lets covsel select just the scenario whose version moved, instead of
  running the whole suite on every change to whatever defines it -- and this
  adapter's recorders declare the new `Recorder.recordsInventoryIds`, so a
  scenario that is _entirely_ inventory-defined -- not a file in this repository
  at all, the ordinary shape for an acceptance suite pinned from elsewhere --
  can be recorded and selected exactly like an ordinary test file, rather than
  needing its own anchor file the way it would with any other adapter.
  `examples/harness-basic`'s `spec:mul` scenario demonstrates it end to end: an
  unchanged scenario skipped, one whose own version moved selected on its own,
  a brand new id run, and a moved harness identity running the whole suite.

  Three small additions elsewhere make this possible without coupling adapters
  to each other or hardcoding a fixed CLI convention:

  - `CovselConfig` gains `harness`, an object opaque to core and owned entirely by
    `@covsel/adapter-harness` -- but still compared like every other field, so a
    project that changes its selection flag or its server's `observes` without a
    new recording does not go on trusting a map recorded under the old meaning of
    either.
  - `SelectionRunInit` (what a `runSelection` capability is called with) gains an
    optional `config`, for an adapter whose native narrowing is itself
    project-configurable rather than a fixed convention every project shares.
    Every caller in this codebase now supplies it.
  - `Recorder` gains `recordsInventoryIds`, declared only by a recorder whose
    `record`/`recordRun` already treat every id as an opaque string handed to
    its own runner rather than a path it reads or executes -- never automatic,
    since asking a generic runner-wrapping adapter (or Vitest's, Jest's,
    Mocha's) to record a virtual id would fail its underlying command rather
    than skip it safely. `recordMap`/`selectAffected`/`covsel status` all
    refused a suite with nothing matching `testGlobs` outright before this,
    even with a real inventory to record from -- the gap the test inventory left
    for whichever adapter actually needed it to decide how it closes.

- Updated dependencies [5a63880]
- Updated dependencies [64d9b0c]
- Updated dependencies [2c18c09]
- Updated dependencies [8d96eb6]
- Updated dependencies [8f3646b]
- Updated dependencies [07f570a]
- Updated dependencies [3edd43b]
- Updated dependencies [237fe2e]
- Updated dependencies [cfc2565]
  - @covsel/core@0.2.0

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
