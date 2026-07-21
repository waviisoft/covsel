# Design — Runtime-Coverage Test Impact Analysis for JS/TS

> The architecture and rationale behind covsel. This is a living reference for
> _why_ the pieces are shaped the way they are; day-to-day work is tracked in
> the [issue tracker](https://github.com/waviisoft/covsel/issues), and
> contributor conventions live in [`AGENTS.md`](./AGENTS.md).

---

## 1. What this is

A command-line tool and library that watches which source code each **test**
executes, builds a persisted **test → covered-code** map, and — given a git diff
— runs only the tests whose covered code changed. Think **code coverage meets
test selection**: the runtime-coverage branch of _Test Impact Analysis (TIA)_.

**Deliberately runner-agnostic.** It works with Vitest, Jest, Mocha, node:test,
cucumber-js, Playwright, or a bespoke harness — because it depends only on the
two things every JS/TS runner shares (see §2).

**One-liner positioning:**

> Runtime-coverage test impact analysis for any JS/TS runner — precise where
> static import-graph selection lies, and the only option for runners that have
> no selection at all.

### Why it doesn't already exist

- **Python** has [`pytest-testmon`], **Java** has Ekstazi/STARTS, **Ruby** has
  Crystalball. **JS/TS has no runtime-coverage equivalent.**
- JS went all-in on **static import-graph** selection instead: `jest
--changedSince`, `vitest --changed`, `playwright --only-changed`, `nx
affected`. Three gaps are the wedge:
  1. Static graphs **lie** on dynamic imports, runtime config, DI/plugin
     coupling, and non-import (fs/fixture) dependencies. Runtime coverage sees
     the truth.
  2. Bundler source-map complexity scared people off. Solving it is the moat.
  3. Every existing tool is **runner-locked**. Runners like cucumber-js have
     _zero_ built-in selection. Be the only cross-runner option.

[`pytest-testmon`]: https://testmon.org

---

## 2. The architecture bet

Two universal contracts make "any runner" tractable:

1. **Bottom:** every runner executes JS that **V8 can observe** — via the
   inspector protocol (`Profiler.takePreciseCoverage`) or `NODE_V8_COVERAGE`.
   You never have to understand the runner to see what code ran.
2. **Top:** every runner **accepts a list of test files**. So the universal
   _output_ of selection is a file list: `myrunner $(covsel affected)` works
   everywhere.

Runner-specific code only appears when refining _past_ file granularity — and
it's opt-in.

### Layered design

```
Adapters      generic-wrap · vitest · jest · mocha · node:test · cucumber · playwright
   (thin, per-runner, OPTIONAL — only for per-test precision & native selection syntax)
Observer      V8 inspector snapshot-diff | NODE_V8_COVERAGE (process) | istanbul
   (shared — turns "a test ran" into a set of executed source ranges)
Mapper        source-maps → original files · bundler awareness · block-hash granularity
   (shared — the hard part; maps transpiled/bundled execution back to src/**)
Store         .covsel/ local · git-notes · GHA cache · S3/GCS
   (pluggable — publish map on main, fetch merge-base map on PR, merge shards)
Selector      git diff → impacted test-ids → emit(file list | runner-native tags)
   + Policy:   fail-open · always-run globs · new-test detection · full-run sentinels
```

The only per-runner code is the top layer — a lifecycle shim calling
`observer.startTest(id)` / `observer.endTest(id)`. These layers are published as
stable interfaces from `@covsel/core`.

### Two granularity levels

- **Level 0 — zero-integration, per-_file_.** Run each test file in its own
  process with `NODE_V8_COVERAGE`; get a per-file map with **no runner
  integration**. The adapter is just "wrap the command." Works with every
  runner. **This is the first target**, and the mechanism is already guarded by
  an integration test in `@covsel/core` that asserts a test file maps to exactly
  the sources it executes.
- **Level 1 — per-_test_.** Snapshot V8 coverage before/after each test via the
  inspector and diff. Selects individual tests/scenarios. Needs one thin
  lifecycle shim per runner. Most of the _wow_, more surface area.

### The two decisions that determine quality

1. **Granularity = hash blocks, not line numbers.** Fingerprint methods/blocks
   by content hash so the map survives reformatting and line shifts. This is the
   difference between a toy and something teams trust.
2. **Fail open, loudly.** The catastrophic failure is _skipping a test that
   should have run_. Every tension resolves toward over-selection:
   - New/changed test files with no map entry → **always run**.
   - **Sentinel files** (`package.json`, tsconfig, test setup, global fixtures,
     lockfile) → invalidate map, **run everything**.
   - **Non-JS deps** coverage can't see (fixtures, snapshots, templates) → track
     fs _reads_ via a hook, or honor user-declared `alwaysRun` globs.
   - **Dynamic/data-dependent branches** → coverage reflects only the path taken;
     document it; always run more, never less.

   **Headline guarantee:** _"We never skip a test whose behavior your change
   could alter — and when we can't be sure, we run it."_

### Known-hard: bundlers (deferred)

Node with on-the-fly transpile (tsx/swc/ts-node) stays ~1:1 → source-mapping via
`v8-to-istanbul` is straightforward. **Browser bundles** (Turbopack/webpack/
esbuild/vite) fuse many sources into one chunk → need source maps to fan
coverage back out. Win the Node/unit/integration case first; browser/bundled
coverage comes later via bundler plugins emitting clean per-source maps.

---

## 3. Target UX (design to this)

> Not yet implemented. Today the CLI ships `--help` and `--version`; the surface
> below is what selection should feel like once it lands.

### CLI surface

```bash
# Record a full run and build/refresh the map
covsel record -- vitest run
covsel record --adapter cucumber -- npm run test:cucumber:ui

# Print the tests affected by the working-tree diff (or a range)
covsel affected                       # vs. merge-base by default
covsel affected --since origin/main
covsel affected --format files        # newline-separated test files (default)
covsel affected --format vitest       # runner-native args
covsel affected --format cucumber     # feature:line / tags

# Run only affected tests (wraps the runner)
covsel run -- vitest run

# Watch: rerun affected tests as you edit (the DX magnet)
covsel watch -- vitest run

# Introspect / debug the map
covsel explain src/app/foo.ts         # which tests cover this file
covsel status                         # map age, coverage %, sentinel triggers
```

### Config file (`covsel.config.ts` / `.covsel.json`)

```jsonc
{
  "adapter": "vitest",
  "store": { "type": "local", "dir": ".covsel" },
  "sourceGlobs": ["src/**"],
  "alwaysRun": ["**/fixtures/**", "src/generated/**"],
  "sentinels": ["package.json", "tsconfig*.json", "vitest.setup.ts"],
  "granularity": "block", // "block" | "file" | "line"
  "failOpen": true,
}
```

### Design principles

- **Zero-config Level 0 works out of the box** — sensible sentinel/alwaysRun
  defaults; config only to refine.
- **Composable, not a framework** — `covsel affected` prints; users pipe it.
  Never wrap what a runner already does well.
- **CI-native** — publish map on `main`, fetch merge-base map on PR, merge shard
  maps.
- **Ship only what works** — commands appear when they're real, not as
  "not implemented" stubs.

---

## 4. Tech & tooling decisions

| Concern              | Choice                                    | Rationale                                                      |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Language             | **TypeScript**, ESM-first, dual CJS build | Ecosystem default; adapters import runner types                |
| Node support         | 20 LTS + 22 + current                     | Inspector + `NODE_V8_COVERAGE` stable; state minimum in README |
| Monorepo             | **pnpm workspaces**                       | Many small packages (core + adapters); fast, strict            |
| Build                | **tsup** (esbuild)                        | Zero-config dual ESM/CJS + `.d.ts`                             |
| The tool's own tests | **Vitest**                                | Also the first-class adapter target — dogfood                  |
| Lint/format          | ESLint (flat) + Prettier                  | Standard                                                       |
| Releases             | **Changesets**                            | Per-package semver, changelog, automated npm publish           |
| Coverage→source      | `v8-to-istanbul`, `istanbul-lib-*`        | Battle-tested source-map remapping                             |
| Diff                 | shell out to `git` (no libgit2 dep)       | Portable, simple, matches CI                                   |
| Docs site            | **VitePress**                             | Low-friction, matches many OSS docs                            |
| License              | **MIT**                                   | Simple, ecosystem default                                      |

---

## 5. Repository structure

```
covsel/
├── packages/
│   ├── core/                 # Observer + Mapper + Store + Selector + Policy + map schema
│   ├── cli/                  # `covsel` command; thin over core
│   ├── adapter-generic/      # Level-0 wrap-any-command (NODE_V8_COVERAGE)
│   └── adapter-*/            # per-runner adapters (vitest, cucumber, jest, …) as they land
├── docs/                     # VitePress site (deployed to GitHub Pages)
├── examples/                 # runnable end-to-end fixtures (as they land)
├── .github/
│   ├── workflows/            # ci.yaml, release.yaml, docs.yaml
│   ├── ISSUE_TEMPLATE/       # bug, feature, adapter, security
│   └── pull_request_template.md
├── AGENTS.md                 # contributor/agent conventions
├── DESIGN.md                 # this document
├── RELEASING.md              # versioning + publish process
├── README.md · CONTRIBUTING.md · CODE_OF_CONDUCT.md · SECURITY.md · CODEOWNERS
├── LICENSE
├── package.json · pnpm-workspace.yaml · tsconfig.base.json
```

### Package boundaries (the contract)

- `core` exposes stable interfaces: `Observer`, `Mapper`, `Store`, `Selector`,
  `Policy`, and the on-disk **map schema** (versioned).
- Adapters depend on `core` only. They implement `startTest(id)/endTest(id)` and
  translate selection → the runner's native input.
- **Adapters are the community contribution surface** — a documented `Adapter`
  interface + a conformance test kit means outside contributors add runners
  without touching core.

---

## 6. Roadmap

Tracked in the open on the
[issue tracker](https://github.com/waviisoft/covsel/issues); the docs
[roadmap](https://waviisoft.github.io/covsel/guide/roadmap) is the reader-facing
version. The shape:

- **Now — foundations.** Repo, toolchain, and CI in place; versioned map schema;
  published layer interfaces; the CLI shell; an integration test proving the
  Level-0 coverage-observation mechanism.
- **Next — file-level selection (the MVP).** Observer (`NODE_V8_COVERAGE` process
  mode), Mapper (coverage → source globs), local Store, file-level Selector,
  fail-open Policy (sentinels, new-test detection); the generic and Vitest
  adapters; `record` / `affected` / `run` / `status`; a golden example proving
  the loop in CI. **Done when** editing one source file selects only the tests
  that execute it, editing a sentinel selects everything, and a new test always
  runs.
- **Later — per-test precision + real adapters.** Inspector snapshot-diff
  observation; block-hash granularity; adapters for Jest, Mocha, node:test,
  cucumber-js, Playwright; the CI publish/fetch/shard-merge story with GHA-cache
  and S3/GCS Stores; `covsel watch`.
- **Beyond — bundlers, monorepos, ecosystem.** Bundler source-map plugins for
  browser coverage; composition with Nx/Turbo project graphs; fs-read tracking
  for non-JS dependencies; an optional remote map service.

---

## 7. Validation strategy

- **Coverage-observation guard.** An integration test in `@covsel/core` runs test
  files under `NODE_V8_COVERAGE` and asserts each maps to exactly the sources it
  executes — the anti-regression guard for the Level-0 mechanism.
- **Golden examples** (`examples/*`) run in CI every push — the executable spec.
- **Adapter conformance kit** — one shared suite every adapter must pass
  (start/end boundaries fire, map is stable across reruns, selection is correct
  on a scripted diff).
- **Pilot on a real, awkward repo.** Target a **cucumber-js + Playwright +
  bundler** project (the quadrant every existing tool ignores). Success =
  scenario-level selection that measurably cuts PR test time without ever
  skipping a test the diff should have triggered. Capture before/after numbers
  for the README.
- **Mutation-style safety check** — deliberately introduce a change and assert
  the affected test is selected; the core guard against fail-_closed_ bugs.

---

## 8. Governance & community

- **Maintainer model:** a small core team owns `core` + release; adapters are the
  open contribution lane.
- **Adapter ownership:** each adapter package lists a maintainer in `CODEOWNERS`;
  community adapters are welcome once they pass the conformance kit.
- **Versioning:** semver per package via Changesets. The **map schema is
  versioned** — a schema bump invalidates stored maps (fail-open: full run) with
  a clear log line. See [`RELEASING.md`](./RELEASING.md).
- **Roadmap in the open:** GitHub issues, with `good first issue` on adapter work.

---

## 9. Risks & open questions

| Risk / question                                    | Mitigation / current stance                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| Fail-_closed_ bug skips a needed test → lost trust | Mutation safety check in CI; conservative defaults; loud logging of skips |
| Bundler source-map fidelity                        | Defer browser coverage; win the Node case first                           |
| "Just use `jest --changedSince`" objection         | Lead with the cases static graphs miss + no-native-selection runners      |
| Map staleness / drift                              | Sentinels + new-test detection + `covsel status` surfacing map age        |
| Per-test inspector overhead                        | Offer Level-0 process mode as the low-overhead fallback                   |
| Monorepo scale                                     | Fuse with Nx/Turbo project graph rather than reimplementing it            |
| Remote map storage for CI                          | GHA cache + S3 first; a hosted service only if demand appears             |
