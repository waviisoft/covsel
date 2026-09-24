# node:test adapter

`@covsel/adapter-node-test` brings **per-test** selection to Node's built-in test
runner. Instead of selecting whole test files, it records what each individual
test executed and runs only the tests a change can affect.

## How it records

Recording preloads a small shim with `node --import`. The shim wraps every test
with the per-test [`InspectorObserver`](/guide/architecture) via node:test's
`beforeEach` / `afterEach` hooks, snapshotting V8 precise coverage before and
after each test and diffing it. Each test's executed sources are written out and
become one map entry per test.

Per-test observation is at **source-file** granularity: V8 precise coverage
reports only the functions that actually ran, so it reliably identifies which
files a test executed. (Per-function precision within a shared file is left to
the whole-file recorders -- see the [generic adapter](/guide/adapters/generic).)

If `covsel record` itself runs with `NODE_V8_COVERAGE` set, `InspectorObserver`
picks that up automatically: instead of diffing a CDP snapshot per test, it
reads a "boot" dump (whatever ran before the first test, credited to all of
them) plus one delta per test straight from that directory. Since this adapter
only ever asks for file-level results, the only visible difference is that code
a test file runs at its own top level is then credited to every test in that
file rather than only the one whose diff happened to include it -- the same
safe direction as everything else here. A dump this cannot attribute to the
process being recorded -- a worker thread or child process that inherited the
env var -- fails the recording rather than guessing.

That crediting relies on the whole file having finished loading by the time
its first test starts, which is true for an ordinary file but not one with a
top-level `await` ahead of a later `test()` call -- node:test can start
running earlier tests while such a file is still being evaluated, so code
after that await is not necessarily credited to a test that runs before it
finishes loading. This is not new to boot-delta mode; the same file's
per-test CDP diffing has the identical gap.

## Setup

Nothing to install beyond covsel -- the shim ships with the adapter and uses only
`node:test` and the inspector.

## Record -> affected -> run

```bash
# Build the map, one entry per individual test
covsel record --adapter node-test -- node --test

# Print the test files the diff can affect (file-level, pipeable)
covsel affected --adapter node-test

# Run only the affected tests -- individual tests, via --test-name-pattern
covsel run --adapter node-test -- node --test
```

When several tests live in one file but touch different sources, editing one
source runs only the test that executed it. `covsel run` invokes node:test over
the affected files with a single `--test-name-pattern` matching the affected
test names; a pattern built from a test's name runs that test even inside a
`describe`, and duplicate names only ever over-run -- so selection stays
fail-open. Files that must run in full (a new or changed test file) are run
without a pattern.
