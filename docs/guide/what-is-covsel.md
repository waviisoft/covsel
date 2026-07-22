# What is covsel?

covsel is a command-line tool and library that watches which source code each
**test** executes, builds a persisted **test → covered-code** map, and — given a
git diff — runs only the tests whose covered code changed. Think **code coverage
meets test selection**: the runtime-coverage branch of _Test Impact Analysis
(TIA)_.

## The problem

Your CI runs every test on every PR, even when the diff touches three files.
Existing JS selection (`jest --changedSince`, `vitest --changed`, `nx affected`)
walks the **static import graph** — which lies on dynamic imports, runtime
config, DI/plugin coupling, and non-import dependencies. And runners like
cucumber-js have no selection at all.

covsel takes the approach proven by Python's
[pytest-testmon](https://testmon.org), Java's Ekstazi/STARTS, and Ruby's
Crystalball: watch what code each test **actually executes** (via V8 coverage),
persist the map, and run only the tests whose covered code changed.

## Why it works with any runner

Two universal contracts make "any runner" tractable:

1. **Bottom:** every runner executes JS that **V8 can observe** — via the
   inspector protocol or `NODE_V8_COVERAGE`. You never have to understand the
   runner to see what code ran.
2. **Top:** every runner **accepts a list of test files**. So the universal
   _output_ of selection is a file list — `myrunner $(covsel affected)` works
   everywhere.

Runner-specific code only appears when refining _past_ file granularity, and
it's opt-in. See [Architecture](/guide/architecture) for the layered design.

## Supported runners

Runners that execute source directly work today through the generic wrap.
Runners that transform sources first (Vitest, Jest) need a per-runner recorder
that reads the runner's own coverage — Vitest is done. Per-test precision comes
later. See [Adapters](/guide/adapters/) for how each is observed.

| Runner                     | Per-file (Level 0)     | Per-test (Level 1) |
| -------------------------- | ---------------------- | ------------------ |
| Any command (generic wrap) | yes (direct-exec)      | —                  |
| node:test                  | yes (generic)          | later              |
| Mocha                      | yes (generic, JS)      | later              |
| Vitest                     | yes (`--adapter`)      | later              |
| Jest                       | planned (own coverage) | later              |
| cucumber-js                | planned (generic)      | later (scenario)   |
| Playwright                 | planned (generic)      | later              |

## Prior art & credits

covsel stands on the shoulders of [pytest-testmon](https://testmon.org)
(Python), [Ekstazi](http://ekstazi.org) and STARTS (Java), and
[Crystalball](https://github.com/toptal/crystalball) (Ruby) — and on
`v8-to-istanbul` and the Istanbul ecosystem for source-map remapping.
