# Project Plan — Runtime-Coverage Test Impact Analysis for JS/TS

> **Design document.** The founding plan for this repository.
>
> **Issue #1 is resolved:** the project is **covsel**, licensed **MIT**, living at
> **github.com/waviisoft/covsel**. Packages: bare `covsel` = CLI, `@covsel/core`,
> `@covsel/adapter-*`. The naming section below is kept for the historical record.

---

## 1. What this is

A command-line tool and library that watches which source code each **test**
executes, builds a persisted **test → covered-code** map, and — given a git diff
— runs only the tests whose covered code changed. Think **code coverage meets
test selection**: the runtime-coverage branch of _Test Impact Analysis (TIA)_.

**Deliberately runner-agnostic.** It works with Vitest, Jest, Mocha, node:test,
cucumber-js, Playwright, or a bespoke harness — because it depends only on the
two things every JS/TS runner shares (see §3).

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

## 2. Naming & identity (Issue #1 — do this first)

Pick the name, then **verify npm scope + GitHub org + domain are free** before
anything else is branded.

Working codename during planning was **`tia`**; final name: **`covsel`**. Shortlist to evaluate:

| Candidate                  | Notes                                                       |
| -------------------------- | ----------------------------------------------------------- |
| `witness`                  | "witnesses what code each test touches"; may collide on npm |
| `sift` / `winnow` / `cull` | evokes narrowing the set; check availability                |
| `covsel`                   | **chosen** — descriptive, bare npm name free                |
| `tracetest`                | rejected: collides with Kubeshop Tracetest                  |
| `impacted`                 | clear, likely taken                                         |
| `runwhat`                  | memorable CLI verb (`runwhat affected`)                     |

Deliverables for the issue: final name, npm org (`@<name>/core`, `@<name>/cli`,
`@<name>/adapter-*`), GitHub org/repo, one-line tagline, reserve the npm names
with a placeholder `0.0.0` publish.

---

## 3. The architecture bet

Two universal contracts make "any runner" tractable:

1. **Bottom:** every runner executes JS that **V8 can observe** — via the
   inspector protocol (`Profiler.takePreciseCoverage`) or `NODE_V8_COVERAGE`.
   You never have to understand the runner to see what code ran.
2. **Top:** every runner **accepts a list of test files**. So the universal
   _output_ of selection is a file list: `myrunner $(tia affected)` works
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
Store         .tia/ local · git-notes · GHA cache · S3/GCS
   (pluggable — publish map on main, fetch merge-base map on PR, merge shards)
Selector      git diff → impacted test-ids → emit(file list | runner-native tags)
   + Policy:   fail-open · always-run globs · new-test detection · full-run sentinels
```

The only per-runner code is the top layer — a lifecycle shim calling
`observer.startTest(id)` / `observer.endTest(id)`.

### Two granularity levels

- **Level 0 — zero-integration, per-_file_.** Run each test file in its own
  process with `NODE_V8_COVERAGE`; get a per-file map with **no runner
  integration**. The adapter is just "wrap the command." Works with every
  runner. **This is the MVP.**
- **Level 1 — per-_test_.** Snapshot V8 coverage before/after each test via the
  inspector and diff. Selects individual tests/scenarios. Needs one thin
  lifecycle shim per runner. Most of the _wow_, more surface area.

### The two decisions that determine quality

1. **Granularity = hash blocks, not line numbers.** Fingerprint methods/blocks
   by content hash so the map survives reformatting and line shifts. This is the
   difference between a toy and something teams trust.
2. **Fail open, loudly.** TIA's catastrophic failure is _skipping a test that
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

### Known-hard: bundlers (scope to v2)

Node with on-the-fly transpile (tsx/swc/ts-node) stays ~1:1 → source-mapping via
`v8-to-istanbul` is straightforward. **Browser bundles** (Turbopack/webpack/
esbuild/vite) fuse many sources into one chunk → need source maps to fan
coverage back out. Win the Node/unit/integration case first; browser/bundled
coverage is v2 (bundler plugins emitting clean per-source maps).

---

## 4. Target UX (design to this)

### CLI surface

```bash
# Record a full run and build/refresh the map
tia record -- vitest run
tia record --adapter cucumber -- npm run test:cucumber:ui

# Print the tests affected by the working-tree diff (or a range)
tia affected                       # vs. merge-base by default
tia affected --since origin/main
tia affected --format files         # newline-separated test files (default)
tia affected --format vitest        # runner-native args
tia affected --format cucumber      # feature:line / tags

# Run only affected tests (wraps the runner)
tia run -- vitest run

# Watch: rerun affected tests as you edit (the DX magnet)
tia watch -- vitest run

# Introspect / debug the map
tia explain src/app/foo.ts          # which tests cover this file
tia status                          # map age, coverage %, sentinel triggers
```

### Config file (`tia.config.ts` / `.tia.json`)

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
- **Composable, not a framework** — `tia affected` prints; users pipe it. Never
  wrap what a runner already does well.
- **CI-native** — publish map on `main`, fetch merge-base map on PR, merge shard
  maps.

---

## 5. Tech & tooling decisions

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
| License              | **MIT** (decided)                         | Simple, ecosystem default                                      |

---

## 6. Repository structure

```
<name>/
├── packages/
│   ├── core/                 # Observer + Mapper + Store + Selector + Policy (runner-agnostic)
│   ├── cli/                  # `tia` command; thin over core
│   ├── adapter-generic/      # Level-0 wrap-any-command (NODE_V8_COVERAGE)
│   ├── adapter-vitest/       # first real adapter
│   ├── adapter-cucumber/     # showcase: a runner with NO native selection
│   ├── adapter-jest/         # (v1)
│   ├── adapter-mocha/        # (v1)
│   ├── adapter-node-test/    # (v1)
│   └── adapter-playwright/   # (v1)
├── examples/
│   ├── vitest-basic/         # golden-path e2e fixture
│   └── cucumber-app/         # exercises the no-native-selection case
├── docs/                     # VitePress site
├── .github/
│   ├── workflows/            # ci.yaml, release.yaml, docs.yaml
│   ├── ISSUE_TEMPLATE/       # bug, feature, adapter-request
│   └── pull_request_template.md
├── DESIGN.md                 # this document
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── LICENSE
├── CHANGELOG.md              # managed by changesets
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
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

## 7. Roadmap & milestones

### Milestone 0 — Repo bootstrap (week 1)

Repo exists, CI is green, an empty-but-real `tia --help` publishes to npm under a
`0.0.x` prerelease tag. OSS scaffolding complete (§8). **Definition of done:** a
contributor can clone, `pnpm i`, `pnpm test`, and `pnpm build` with zero manual
steps.

### Milestone 1 — MVP: Level-0 file-level selection (weeks 2–4)

- `core`: Observer (`NODE_V8_COVERAGE` process mode), Mapper (source-map →
  `sourceGlobs`), local Store, file-level Selector, Policy (fail-open, sentinels,
  new-test detection).
- `adapter-generic` + `adapter-vitest`.
- CLI: `record`, `affected`, `run`, `status`.
- `examples/vitest-basic` proves the loop end-to-end in CI.
- **Definition of done:** on the example, editing one source file selects only the
  test files that execute it; editing a sentinel selects everything; a brand-new
  test always runs. Prove it against a real repo (see §9).

### Milestone 2 — v1: per-test precision + real adapters (weeks 5–10)

- Inspector snapshot-diff Observer (per-test granularity).
- **Block-hash** granularity in the Mapper.
- Adapters: `jest`, `mocha`, `node:test`, **`cucumber`**, `playwright`.
- CI story: publish-map-on-main, fetch-merge-base-map-on-PR, **shard-merge**;
  Stores for GitHub Actions cache + S3/GCS.
- `tia watch`.
- `examples/cucumber-app` as the no-native-selection showcase.
- **Definition of done:** cucumber-js scenario-level selection works on the
  example and on the pilot repo; CI selects across 3+ shards correctly.

### Milestone 3 — v2: bundlers, monorepo, ecosystem (post-launch)

- Bundler source-map plugins (Turbopack/webpack/esbuild/vite) for browser
  coverage.
- **Compose with** Nx/Turbo project graphs (don't compete — fuse project-level +
  test-level selection).
- fs-read tracking for non-JS dependencies.
- Optional remote map service.

---

## 8. OSS scaffolding checklist (Milestone 0)

- [ ] `LICENSE` (MIT unless Apache-2.0 chosen)
- [ ] `README.md` — problem, 30-second quickstart, the fail-open guarantee,
      supported runners matrix, prior-art credits (testmon/Ekstazi/Crystalball)
- [ ] `CONTRIBUTING.md` — dev setup, how to write an adapter (link the conformance kit)
- [ ] `CODE_OF_CONDUCT.md` — Contributor Covenant
- [ ] `SECURITY.md` — private disclosure; note the tool reads source & git but
      makes no network calls unless a remote Store is configured
- [ ] Issue templates: bug, feature, **adapter-request**
- [ ] PR template
- [ ] `.github/workflows/ci.yaml` — lint, typecheck, unit, examples e2e, matrix
      over Node 20/22/current
- [ ] `.github/workflows/release.yaml` — Changesets → npm publish (provenance on)
- [ ] `.github/workflows/docs.yaml` — VitePress build/deploy
- [ ] Branch protection + required CI check
- [ ] `CODEOWNERS`
- [ ] npm publish with **provenance** (`--provenance`) and 2FA on the org

---

## 9. Validation strategy

- **Golden examples** (`examples/*`) run in CI every push — the executable spec.
- **Adapter conformance kit** — one shared suite every adapter must pass
  (start/end boundaries fire, map is stable across reruns, selection is correct
  on a scripted diff).
- **Pilot on a real, awkward repo.** Target a **cucumber-js + Playwright +
  bundler** project (this is the quadrant every existing tool ignores). Success =
  scenario-level selection that measurably cuts PR test time without ever
  skipping a test the diff should have triggered. Capture before/after numbers
  for the README.
- **Mutation-style safety check** — deliberately introduce a change and assert
  the affected test is selected; the core anti-regression guard against
  fail-_closed_ bugs.

---

## 10. Governance & community

- **Maintainer model:** start with a small core team owning `core` + release;
  adapters are the open contribution lane.
- **Adapter ownership:** each adapter package lists a maintainer in `CODEOWNERS`;
  community adapters welcome once they pass the conformance kit.
- **Versioning:** semver per package via Changesets. The **map schema is
  versioned** — a schema bump invalidates stored maps (fail-open: full run) with
  a clear log line.
- **Roadmap in the open:** GitHub Projects board, `good-first-issue` on adapter
  work.

---

## 11. Risks & open questions

| Risk / question                                    | Mitigation / decision needed                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| Fail-_closed_ bug skips a needed test → lost trust | Mutation safety check in CI; conservative defaults; loud logging of skips |
| Bundler source-map fidelity                        | Scope browser coverage to v2; win Node case first                         |
| "Just use `jest --changedSince`" objection         | Lead with the cases static graphs miss + no-native-selection runners      |
| Map staleness / drift                              | Sentinels + new-test detection + `tia status` surfacing map age           |
| Per-test inspector overhead                        | Offer Level-0 process mode as the low-overhead fallback                   |
| Monorepo scale                                     | v2 fusion with Nx/Turbo project graph rather than reimplementing it       |
| **License choice** (MIT vs Apache-2.0)             | Decide in Issue #1                                                        |
| **Remote map storage** for CI                      | GHA cache + S3 in v1; hosted service only if demand appears               |

---

## 12. Seed issue backlog

**M0** — #1 Name + npm/GitHub/domain reservation + license · #2 pnpm monorepo +
tsup + tsconfig base · #3 CI (lint/typecheck/test matrix) · #4 Changesets +
release workflow · #5 OSS scaffolding files (§8) · #6 `core` package skeleton +
versioned map schema · #7 `cli` skeleton (`--help`, command stubs) · #8 VitePress
docs shell.

**M1** — #9 Observer: `NODE_V8_COVERAGE` process mode · #10 Mapper: source-map →
sourceGlobs · #11 Local Store + map read/write · #12 Selector: file-level diff →
tests · #13 Policy: fail-open + sentinels + new-test detection · #14
`adapter-generic` · #15 `adapter-vitest` · #16 `examples/vitest-basic` + e2e CI ·
#17 `tia affected`/`record`/`run`/`status`.

**M2** — #18 Inspector snapshot-diff Observer (per-test) · #19 Block-hash
granularity · #20 `adapter-cucumber` + example · #21 adapter-jest · #22
adapter-mocha · #23 adapter-node-test · #24 adapter-playwright · #25 CI map
publish/fetch/merge · #26 Store: GHA cache · #27 Store: S3/GCS · #28 `tia watch` ·
#29 Adapter conformance kit · #30 Mutation safety check.

**M3** — #31 Bundler source-map plugins · #32 Nx/Turbo project-graph fusion · #33
fs-read dependency tracking · #34 remote map service (spike).

---

## 13. First-week checklist (for whoever picks this up)

1. Settle name + license (Issue #1); reserve npm org + GitHub org + domain.
2. `pnpm init` workspace; add `core`, `cli`, `adapter-generic` empty packages.
3. tsup + tsconfig base + ESLint/Prettier; `pnpm build` and `pnpm test` green.
4. CI workflow (matrix Node 20/22/current) + Changesets release workflow.
5. Land OSS scaffolding (§8) and this `DESIGN.md`.
6. Spike the Observer: prove `NODE_V8_COVERAGE` yields a per-file map on a
   two-test example — that spike de-risks the whole MVP.
