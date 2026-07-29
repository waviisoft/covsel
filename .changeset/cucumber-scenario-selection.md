---
'@covsel/adapter-cucumber': minor
'@covsel/core': minor
'covsel': minor
---

Add scenario-level selection for cucumber-js, the runner with no built-in test
selection at all. The new `@covsel/adapter-cucumber` records what each
_scenario_ executes — a support-code shim loaded through cucumber's own
`--import` wraps every scenario with the per-scenario inspector observer — and
`covsel run --adapter cucumber` runs only the affected scenarios via `--name`.
Editing one source now runs a single scenario instead of the whole suite.

Feature files are discovered automatically when the adapter is selected, so no
configuration is needed. `@covsel/core` gains `loadRawConfig`, which reads the
user's config without applying defaults so an adapter can supply its own test
globs only when the project has not set them.
