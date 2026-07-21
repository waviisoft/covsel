# covsel

> Runtime-coverage test impact analysis for any JS/TS runner — precise where
> static import-graph selection lies, and the only option for runners that have
> no selection at all.

**Status: pre-alpha (Milestone 0).** The map schema, layer interfaces, and CLI
surface exist; selection lands in Milestone 1. See [`DESIGN.md`](./DESIGN.md).

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

## Quickstart (target UX — Milestone 1)

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

| Runner                     | Level 0 (per-file) | Level 1 (per-test)  |
| -------------------------- | ------------------ | ------------------- |
| Any command (generic wrap) | M1                 | —                   |
| Vitest                     | M1                 | M2                  |
| Jest                       | M1 (generic)       | M2                  |
| Mocha                      | M1 (generic)       | M2                  |
| node:test                  | M1 (generic)       | M2                  |
| cucumber-js                | M1 (generic)       | M2 (scenario-level) |
| Playwright                 | M1 (generic)       | M2                  |

## Packages

| Package                   | Purpose                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `covsel`                  | The CLI                                                                  |
| `@covsel/core`            | Observer · Mapper · Store · Selector · Policy + the versioned map schema |
| `@covsel/adapter-generic` | Level-0 wrap-any-command adapter                                         |
| `@covsel/adapter-*`       | Per-runner adapters (community contribution lane)                        |

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint && pnpm typecheck
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
