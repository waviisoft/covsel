# covsel

> Runtime-coverage test impact analysis for any JS/TS runner — precise where
> static import-graph selection lies, and the only option for runners that have
> no selection at all.

**Status: pre-alpha.** The map schema, layer interfaces, and CLI shell exist;
selection is in progress. Track the work in the
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

## Quickstart (target UX)

> The selection commands below are the target UX and are not available yet; the
> CLI currently ships `--help` and `--version`. Follow the
> [issues](https://github.com/waviisoft/covsel/issues) for progress.

```bash
# Record a full run and build the map
npx covsel record -- vitest run

# Print the tests affected by your working-tree diff
npx covsel affected

# Or just run them
npx covsel run -- vitest run
```

Zero config to start. Works with any runner that accepts a list of test files —
which is all of them.

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

All runners are supported at the file level through the generic wrap; per-test
precision is planned per runner.

| Runner                     | Per-file (Level 0) | Per-test (Level 1) |
| -------------------------- | ------------------ | ------------------ |
| Any command (generic wrap) | planned            | —                  |
| Vitest                     | planned            | later              |
| Jest                       | planned (generic)  | later              |
| Mocha                      | planned (generic)  | later              |
| node:test                  | planned (generic)  | later              |
| cucumber-js                | planned (generic)  | later (scenario)   |
| Playwright                 | planned (generic)  | later              |

## Packages

| Package                   | Purpose                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `covsel`                  | The CLI                                                                  |
| `@covsel/core`            | Observer · Mapper · Store · Selector · Policy + the versioned map schema |
| `@covsel/adapter-generic` | Level-0 wrap-any-command adapter                                         |
| `@covsel/adapter-*`       | Per-runner adapters (community contribution lane)                        |

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

Node ≥ 20 required. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Prior art & credits

covsel stands on the shoulders of [pytest-testmon] (Python),
[Ekstazi](http://ekstazi.org) and STARTS (Java), and
[Crystalball](https://github.com/toptal/crystalball) (Ruby) — and on
`v8-to-istanbul` and the Istanbul ecosystem for source-map remapping.

[pytest-testmon]: https://testmon.org

## License

[MIT](./LICENSE)
