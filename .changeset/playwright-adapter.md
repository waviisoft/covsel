---
'@covsel/adapter-playwright': minor
'@covsel/core': minor
---

Add `@covsel/adapter-playwright`: per-test selection for Playwright, recorded
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
