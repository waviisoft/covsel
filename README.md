# covsel

> Runtime-coverage test impact analysis for any JS/TS runner — precise where
> static import-graph selection lies, and the only option for runners that have
> no selection at all.

**Status: early.** The `covsel record`, `affected`, `run`, and `status` loop
works today, with block-hash (function-level) selection, per-test selection for
node:test, and scenario-level selection for cucumber-js. More runner adapters and
the CI map-sharing story are next. Track the work in the
[issues](https://github.com/waviisoft/covsel/issues), and see
[`DESIGN.md`](./DESIGN.md) for the architecture.

## The problem

Your CI runs every test on every PR, even when the diff touches three files.
Existing JS selection (`jest --changedSince`, `vitest --changed`, `nx affected`)
walks the **static import graph** — which lies on dynamic imports, runtime
config, DI/plugin coupling, and non-import dependencies. And runners like
cucumber-js have no selection at all.

covsel takes the approach proven by Python's [pytest-testmon], Java's
Ekstazi/STARTS, and Ruby's Crystalball: **watch what code each test actually
executes** (via V8 coverage), persist a test → covered-code map, and — given a
git diff — run only the tests whose covered code changed.

## Quickstart

```bash
# Record a run and build the map (one process per test file)
npx covsel record -- node --test
npx covsel record --adapter vitest -- vitest run   # needs @vitest/coverage-v8

# Print the tests your working-tree diff can affect
npx covsel affected                 # newline-separated test files
npx covsel affected --since origin/main

# Run only those tests by wrapping the runner
npx covsel run -- node --test

# Runners with no selection of their own: pick individual scenarios
npx covsel record --adapter cucumber -- cucumber-js
npx covsel run --adapter cucumber -- cucumber-js

# Inspect the map: age, size, sentinel drift, next action
npx covsel status
```

Zero config to start. `covsel affected` prints a file list, so you can pipe it
into any runner that accepts test files: `node --test $(covsel affected)`.

Vitest transforms sources before executing them, so raw V8 process coverage
can't see your `src/**`; `--adapter vitest` records through Vitest's own V8
coverage provider instead. The generic wrap is for runners that execute source
directly (e.g. `node --test`, Mocha on plain JS).

## The fail-open guarantee

The catastrophic failure for a tool like this is _skipping a test that should
have run_. Every design tension resolves toward over-selection:

- New or changed test files with no map entry **always run**.
- Changes to **sentinel files** (`package.json`, tsconfig, lockfile, test setup)
  invalidate the map and trigger a **full run**.
- A stale or unreadable map means a **full run**, never a skipped one.

**We never skip a test whose behavior your change could alter — and when we
can't be sure, we run it.**

## Supported runners

Runners that execute source directly work today through the generic wrap.
Runners that transform sources first (Vitest, Jest) need a per-runner recorder
that reads the runner's own coverage; Vitest is done. Per-test selection ships
for node:test, and scenario-level selection for cucumber-js.

| Runner                     | Per-file           | Per-test / scenario |
| -------------------------- | ------------------ | ------------------- |
| Any command (generic wrap) | yes (direct-exec)  | —                   |
| node:test                  | yes (generic)      | yes (`--adapter`)   |
| cucumber-js                | —                  | yes (`--adapter`)   |
| Mocha                      | yes (generic, JS)  | later               |
| Vitest                     | yes (`--adapter`)  | later               |
| Jest                       | planned (own cov.) | later               |
| Playwright                 | planned (generic)  | later               |

## Packages

| Package                     | Purpose                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `covsel`                    | The CLI                                                                  |
| `@covsel/core`              | Observer · Mapper · Store · Selector · Policy + the versioned map schema |
| `@covsel/adapter-generic`   | Wrap-any-command adapter (whole-file)                                    |
| `@covsel/adapter-vitest`    | Vitest adapter (records via Vitest's own V8 coverage)                    |
| `@covsel/adapter-node-test` | node:test adapter (per-test selection via the inspector observer)        |
| `@covsel/adapter-cucumber`  | cucumber-js adapter (scenario-level selection)                           |
| `@covsel/adapter-*`         | Per-runner adapters (community contribution lane)                        |

## Documentation

Full docs: **https://waviisoft.github.io/covsel/** (source in [`docs/`](./docs)).

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint && pnpm typecheck
pnpm docs:dev      # run the docs site locally
```

Node ≥ 22 required. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Prior art & credits

covsel stands on the shoulders of [pytest-testmon] (Python),
[Ekstazi](http://ekstazi.org) and STARTS (Java), and
[Crystalball](https://github.com/toptal/crystalball) (Ruby) — and on
`v8-to-istanbul` and the Istanbul ecosystem for source-map remapping.

[pytest-testmon]: https://testmon.org

## License

[MIT](./LICENSE)
