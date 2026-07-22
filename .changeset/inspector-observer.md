---
'@covsel/core': minor
---

Add `InspectorObserver`, the Level-1 (per-test) observation primitive. It
snapshots V8 precise coverage before and after each test via the inspector and
diffs the counts, attributing execution to the individual test rather than the
whole file, all within one process. Its output is V8 ScriptCoverage-shaped, so
it feeds the existing `V8FileMapper`. A runner adapter drives it by calling
`startTest(id)` / `endTest(id)` around each test — the only per-runner code. An
integration test guards the mechanism: two tests sharing a module are each
credited with only the sources they executed. Wiring it into a runner and the
per-test selection pipeline is a follow-up.
