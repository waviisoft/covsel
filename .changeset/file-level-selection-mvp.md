---
'@covsel/core': minor
'covsel': minor
'@covsel/adapter-vitest': minor
---

Add the file-level selection MVP: `covsel record`, `affected`, `run`, and `status`.

`@covsel/core` gains zero-config `CovselConfig` loading, a `ProcessObserver`
(NODE_V8_COVERAGE process mode) and `V8FileMapper`, a local JSON `Store`, a git
diff helper, a file-level `Selector`, a fail-open `Policy` (sentinels, mandatory
new/changed tests), and command orchestration (`recordMap`, `selectAffected`,
`runAffected`, `computeStatus`) behind a pluggable `Recorder`. A new
`@covsel/adapter-vitest` records with Vitest's own V8 coverage — raw
NODE_V8_COVERAGE cannot see Vitest-transformed sources — while `adapter-generic`
remains the default wrap for runners that execute source directly.
