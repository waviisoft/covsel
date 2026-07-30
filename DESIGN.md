# Design -- Runtime-Coverage Test Impact Analysis for JS/TS

> The architecture and rationale behind covsel. This is a living reference for
> _why_ the pieces are shaped the way they are, and it describes covsel as it is
> today -- planned work is tracked in the
> [issue tracker](https://github.com/waviisoft/covsel/issues), never here.
> Contributor conventions live in [`AGENTS.md`](./AGENTS.md).

---

## 1. What this is

A command-line tool and library that watches which source code each **test**
executes, builds a persisted **test -> covered-code** map, and -- given a git diff
-- runs only the tests whose covered code changed. Think **code coverage meets
test selection**: the runtime-coverage branch of _Test Impact Analysis (TIA)_.

**Deliberately runner-agnostic.** It works with Vitest, Jest, node:test,
cucumber-js, Mocha, or a bespoke harness -- because it depends only on the two
things every JS/TS runner shares (see section 2).

**One-liner positioning:**

> Runtime-coverage test impact analysis for any JS/TS runner -- precise where
> static import-graph selection lies, and the only option for runners that have
> no selection at all.

### Why it doesn't already exist

- **Python** has [`pytest-testmon`], **Java** has Ekstazi/STARTS, **Ruby** has
  Crystalball. **JS/TS has no runtime-coverage equivalent.**
- JS went all-in on **static import-graph** selection instead: `jest
--changedSince`, `vitest --changed`, `nx affected`. Three gaps are the wedge:
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

1. **Bottom:** every runner executes JS that **V8 can observe** -- via the
   inspector protocol (`Profiler.takePreciseCoverage`) or `NODE_V8_COVERAGE`.
   You never have to understand the runner to see what code ran.
2. **Top:** every runner **accepts a list of test files**. So the universal
   _output_ of selection is a file list: `myrunner $(covsel affected)` works
   everywhere.

Runner-specific code only appears when refining _past_ file granularity -- and
it's opt-in.

### Layered design

```
Adapters      generic-wrap, vitest, jest, node:test, cucumber
   (thin, per-runner, OPTIONAL -- only for per-test precision & native selection syntax)
Observer      V8 inspector snapshot-diff | NODE_V8_COVERAGE (process)
   (shared -- turns "a test ran" into a set of executed source ranges)
Mapper        source-maps -> original files, bundler awareness, block-hash granularity
   (shared -- the hard part; maps transpiled/bundled execution back to src/**)
Store         .covsel/ local, the one implementation (a directory, so a CI cache can carry it)
   (an interface in core; `covsel merge` folds sharded maps into one)
Selector      git diff -> impacted test-ids -> a test-file list, or a narrowed run via the adapter
   + Policy:   fail-open, always-run globs, new-test detection, full-run sentinels
```

The only per-runner code is the top layer -- a lifecycle shim calling
`observer.startTest(id)` / `observer.endTest(id)`. These layers are published as
stable interfaces from `@covsel/core`.

### Two granularity levels

- **Zero-integration, per-_file_.** Run each test file in its own
  process with `NODE_V8_COVERAGE`; get a per-file map with **no runner
  integration**. The adapter is just "wrap the command." Works with every runner
  that executes your source directly, and the mechanism is guarded by an
  integration test in `@covsel/core` that asserts a test file maps to exactly the
  sources it executes.
- **Per-_test_.** Snapshot V8 coverage before/after each test via the
  inspector and diff. Selects individual tests/scenarios. Needs one thin
  lifecycle shim per runner. Most of the _wow_, more surface area.

### The two decisions that determine quality

1. **Granularity = hash blocks, not line numbers.** Fingerprint methods/blocks
   by content hash so the map survives reformatting and line shifts. This is the
   difference between a toy and something teams trust.
2. **Fail open, loudly.** The catastrophic failure is _skipping a test that
   should have run_. Every tension resolves toward over-selection:
   - New/changed test files with no map entry -> **always run**.
   - **Sentinel files** (`package.json`, tsconfig, test setup, global fixtures,
     lockfile) -> invalidate map, **run everything**.
   - **Non-JS deps** coverage can't see (fixtures, snapshots, templates) -> honor
     user-declared `alwaysRun` globs.
   - **Dynamic/data-dependent branches** -> coverage reflects only the path taken;
     document it; always run more, never less.

   **Headline guarantee:** _"We never skip a test whose behavior your change
   could alter -- and when we can't be sure, we run it."_

### Known-hard: bundles

Node with on-the-fly transpile (tsx/swc/ts-node) stays ~1:1, so the offsets V8
reports are the offsets on disk. **Browser bundles** (Turbopack/webpack/
esbuild/vite) fuse many sources into one chunk -> they need source maps to fan
coverage back out, and a bundle whose build published none cannot be traced home
at all.

covsel's answer to that last case is to refuse rather than guess. A script that
executed and resolves to no source in the repository **fails the recording**,
naming the script, and no map is written -- because an entry that credits nothing
is read afterwards as a test that covers nothing, and that skips it on every
diff. Maps are looked for everywhere a build publishes one (a `sourceMappingURL`
comment, an inline `data:` URI, the conventional `<script>.map` neighbour, over
HTTP, and in a build directory served URLs map onto), and a source fetched
without a disk-relative anchor is confirmed against `sourcesContent` before it is
credited. Scripts that genuinely never will be mappable are allowed by listing
them in `sourceMaps.allowUnmappable`, and named on every recording that lets one
through. What the mapper reads is carried to it whole, so a recorder that maps
inside a runner it spawned applies the same configuration as one mapping in
process.

Fanning coverage back out is done from the mapping segments themselves rather
than through an off-the-shelf istanbul conversion, which was measured to lose the
cases that matter: those conversions carry named functions only, so an executed
arrow handler vanishes, and they attribute unmapped bundler-injected code to the
map's first source. Both drop blocks, and a dropped block skips a test. That
projection lives in `@covsel/core` as a primitive the recorder does not call, so
what a mapped bundle credits today is every source it was built from rather than
the ranges that executed -- coarse, and over-selecting, which is the safe
direction to be coarse in.

The consequence is that covsel covers the Node/unit/integration case. Coverage of
code executing inside a browser is not something it can observe today.

---

## 3. The user-facing surface

### CLI surface

```bash
# Set the project up: detect the runner, install its adapter, write the config
covsel init

# Record a full run and build/refresh the map
covsel record -- vitest run
covsel record --adapter cucumber -- cucumber-js

# Print the tests affected by the working-tree diff (or a range).
# Every command resolves an adapter, not just `record`: --adapter first, then
# the one `init` wrote to the config, then `generic`. covsel bundles none, so
# whichever name wins has to name a package the project installed.
covsel affected                       # vs. the commit the map was recorded on
covsel affected --since origin/main
covsel affected --format files        # test files, one per line (default)

# Run only affected tests (wraps the runner)
covsel run -- vitest run

# Watch: rerun affected tests as you edit (the DX magnet)
covsel watch -- vitest run

# Introspect the map: age, size, sentinel drift, whether the next run is full
covsel status

# Fold the maps from a sharded suite into one
covsel merge shard-*/map.json --out .covsel/map.json
```

### Config file (`covsel.json` / `covsel.config.js`)

Every field but `adapter` has a default, so a project that installs an adapter
needs no config file at all; `covsel init` writes one so the adapter choice is
made once. The comments below are for the reader -- `covsel.json` is parsed as
strict JSON.

```jsonc
{
  "adapter": "vitest", // what `--adapter` would otherwise say every time
  "testGlobs": ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  "sourceGlobs": ["src/**"],
  "alwaysRun": ["**/fixtures/**"],
  "sentinels": ["package.json", "tsconfig*.json", "vitest.setup.ts"],
  "granularity": "block", // "block" (function-level) | "file"
  "sourceMaps": { "buildDirs": [], "http": true, "allowUnmappable": [] },
  "store": { "dir": ".covsel" },
}
```

### Design principles

- **Zero-config once an adapter is installed** -- the CLI ships none, so
  a project installs `covsel` plus the adapter for its runner and then needs no
  configuration; sensible sentinel/alwaysRun defaults, config only to refine.
- **Composable, not a framework** -- `covsel affected` prints; users pipe it.
  Never wrap what a runner already does well.
- **CI-native** -- record and cache the map on `main`, restore it on a pull
  request, merge shard maps with `covsel merge`. The store is a directory, so the
  CI runner's own cache is the transport.
- **Ship only what works** -- commands appear when they're real, not as
  "not implemented" stubs.

---

## 4. Tech & tooling decisions

| Concern              | Choice                                    | Rationale                                                      |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Language             | **TypeScript**, ESM-first, dual CJS build | Ecosystem default; adapters import runner types                |
| Node support         | 22 LTS + 24 + current                     | Inspector + `NODE_V8_COVERAGE` stable; state minimum in README |
| Monorepo             | **pnpm workspaces**                       | Many small packages (core + adapters); fast, strict            |
| Build                | **tsup** (esbuild)                        | Zero-config dual ESM/CJS + `.d.ts`                             |
| The tool's own tests | **Vitest**                                | Also the first-class adapter target -- dogfood                 |
| Lint/format          | ESLint (flat) + Prettier                  | Standard                                                       |
| Releases             | **Changesets**                            | Per-package semver, changelog, automated npm publish           |
| Coverage->source     | Source-map resolution in `@covsel/core`   | No runtime dependency; the mapper owns what it credits         |
| Diff                 | shell out to `git` (no libgit2 dep)       | Portable, simple, matches CI                                   |
| Docs site            | **VitePress**                             | Low-friction, matches many OSS docs                            |
| License              | **MIT**                                   | Simple, ecosystem default                                      |

---

## 5. Repository structure

```
covsel/
|-- packages/
|   |-- core/                 # Observer + Mapper + Store + Selector + Policy + map schema
|   |-- cli/                  # `covsel` command; thin over core
|   |-- adapter-generic/      # wrap-any-command (NODE_V8_COVERAGE)
|   |-- adapter-*/            # per-runner adapters (vitest, jest, node-test, cucumber)
|   `-- conformance/          # the shared suite every adapter must pass
|-- docs/                     # VitePress site (deployed to GitHub Pages)
|-- examples/                 # runnable end-to-end fixtures, driven by CI
|-- .github/
|   |-- workflows/            # ci.yaml, release.yaml, docs.yaml
|   |-- ISSUE_TEMPLATE/       # bug, feature, adapter, security
|   `-- pull_request_template.md
|-- AGENTS.md                 # contributor/agent conventions
|-- DESIGN.md                 # this document
|-- RELEASING.md              # versioning + publish process
|-- README.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, CODEOWNERS
|-- LICENSE
|-- package.json, pnpm-workspace.yaml, tsconfig.base.json
```

### Package boundaries (the contract)

- `core` exposes stable interfaces: `Observer`, `Mapper`, `Store`, `Selector`,
  `Policy`, and the on-disk **map schema** (versioned).
- Adapters depend on `core` only. They implement `startTest(id)/endTest(id)` and
  translate selection -> the runner's native input.
- **Adapters are the community contribution surface** -- a documented `Adapter`
  interface + a conformance test kit means outside contributors add runners
  without touching core.

---

## 6. Validation strategy

- **Coverage-observation guard.** An integration test in `@covsel/core` runs test
  files under `NODE_V8_COVERAGE` and asserts each maps to exactly the sources it
  executes -- the anti-regression guard for the per-file mechanism.
- **Golden examples** (`examples/*`) run in CI every push -- the executable spec.
- **Adapter conformance kit** -- one shared suite every adapter must pass
  (start/end boundaries fire, map is stable across reruns, selection is correct
  on a scripted diff).
- **Mutation-style safety check** -- deliberately introduce a change and assert
  the affected test is selected; the core guard against fail-_closed_ bugs.

---

## 7. Governance & community

- **Maintainer model:** a small core team owns `core` + release; adapters are the
  open contribution lane.
- **Adapter ownership:** each adapter package lists a maintainer in `CODEOWNERS`;
  community adapters are welcome once they pass the conformance kit.
- **Versioning:** semver per package via Changesets. The **map schema is
  versioned** -- a schema bump invalidates stored maps (fail-open: full run) with
  a clear log line. See [`RELEASING.md`](./RELEASING.md).
- **Planned work in the open:** it lives in GitHub issues, with `good first issue`
  on adapter work -- not in this document, which describes covsel as it is.

---

## 8. Risks & open questions

| Risk / question                                     | Mitigation / current stance                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| Fail-_closed_ bug skips a needed test -> lost trust | Mutation safety check in CI; conservative defaults; loud logging of skips |
| Bundler source-map fidelity                         | A script that maps back to no source fails the recording, loudly          |
| "Just use `jest --changedSince`" objection          | Lead with the cases static graphs miss + no-native-selection runners      |
| Map staleness / drift                               | Sentinels + new-test detection + `covsel status` surfacing map age        |
| Per-test inspector overhead                         | Offer per-file process mode as the low-overhead fallback                  |
| Sharing the map across CI jobs                      | The store is a directory, so the CI runner's own cache covers it          |
