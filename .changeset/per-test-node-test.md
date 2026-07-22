---
'@covsel/core': minor
'@covsel/adapter-node-test': minor
'covsel': minor
---

Add per-test selection for Node's built-in test runner. The new
`@covsel/adapter-node-test` records each test individually — a preload shim
drives the Level-1 `InspectorObserver` around every test via node:test's
`beforeEach`/`afterEach` — and `covsel run --adapter node-test` runs only the
affected tests using `--test-name-pattern`. Two tests in one file that execute
different sources are now selected independently; editing one source runs only
the test that touched it.

Per-test observation is at source-file granularity: V8 precise coverage reports
only the functions that ran, so it reliably tells which files a test executed
but not which un-run functions to exclude on a shared file — per-function
precision under per-test observation is left to the whole-file recorders.

`@covsel/core` generalizes the `Recorder` contract to return one `RecordedUnit`
per test (`record(): Promise<RecordedUnit[]>`), `recordMap` writes one map entry
per test, and `selectAffected` returns the selected test units (`selected`)
alongside the file list. The generic and Vitest recorders return a single
whole-file unit and are otherwise unchanged.
