# node:test adapter

`@covsel/adapter-node-test` brings **per-test** selection to Node's built-in test
runner. Instead of selecting whole test files, it records what each individual
test executed and runs only the tests a change can affect.

## How it records

Recording preloads a small shim with `node --import`. The shim wraps every test
with the Level-1 [`InspectorObserver`](/guide/architecture) via node:test's
`beforeEach` / `afterEach` hooks, snapshotting V8 precise coverage before and
after each test and diffing it. Each test's executed sources are written out and
become one map entry per test.

Per-test observation is at **source-file** granularity: V8 precise coverage
reports only the functions that actually ran, so it reliably identifies which
files a test executed. (Per-function precision within a shared file is left to
the whole-file recorders — see the [generic adapter](/guide/adapters/generic).)

## Setup

Nothing to install beyond covsel — the shim ships with the adapter and uses only
`node:test` and the inspector.

## Record → affected → run

```bash
# Build the map, one entry per individual test
covsel record --adapter node-test -- node --test

# Print the test files the diff can affect (file-level, pipeable)
covsel affected

# Run only the affected tests — individual tests, via --test-name-pattern
covsel run --adapter node-test -- node --test
```

When several tests live in one file but touch different sources, editing one
source runs only the test that executed it. `covsel run` groups the affected
tests by file and invokes node:test with a `--test-name-pattern` matching their
names; a pattern built from a test's name runs that test even inside a
`describe`, and duplicate names only ever over-run — so selection stays
fail-open. Files that must run in full (a new or changed test file) are run
without a pattern.
