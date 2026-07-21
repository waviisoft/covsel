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

| Runner                     | Level 0 (per-file) | Level 1 (per-test)  |
| -------------------------- | ------------------ | ------------------- |
| Any command (generic wrap) | M1                 | —                   |
| Vitest                     | M1                 | M2                  |
| Jest                       | M1 (generic)       | M2                  |
| Mocha                      | M1 (generic)       | M2                  |
| node:test                  | M1 (generic)       | M2                  |
| cucumber-js                | M1 (generic)       | M2 (scenario-level) |
| Playwright                 | M1 (generic)       | M2                  |

## Prior art & credits

covsel stands on the shoulders of [pytest-testmon](https://testmon.org)
(Python), [Ekstazi](http://ekstazi.org) and STARTS (Java), and
[Crystalball](https://github.com/toptal/crystalball) (Ruby) — and on
`v8-to-istanbul` and the Istanbul ecosystem for source-map remapping.
