# Architecture

covsel is a set of layers with narrow contracts. Only the top layer is ever
runner-specific, and it's optional.

```
Adapters      generic-wrap · vitest · jest · mocha · node:test · cucumber · playwright
   (thin, per-runner, OPTIONAL — only for per-test precision & native selection syntax)
Observer      V8 inspector snapshot-diff | NODE_V8_COVERAGE (process) | istanbul
   (shared — turns "a test ran" into a set of executed source ranges)
Mapper        source-maps → original files · bundler awareness · block-hash granularity
   (shared — the hard part; maps transpiled/bundled execution back to src/**)
Store         .covsel/ local · git-notes · GHA cache · S3/GCS
   (pluggable — publish map on main, fetch merge-base map on PR, merge shards)
Selector      git diff → impacted test-ids → emit(file list | runner-native tags)
   + Policy:   fail-open · always-run globs · new-test detection · full-run sentinels
```

`@covsel/core` exposes these as stable interfaces — `Observer`, `Mapper`,
`Store`, `Selector`, `Policy`, `Adapter` — plus the versioned map schema.
Adapters depend on `core` only.

## Two granularity levels

- **Level 0 — zero-integration, per-_file_.** Run each test file in its own
  process with `NODE_V8_COVERAGE`; get a per-file map with **no runner
  integration**. The adapter is just "wrap the command." This is the MVP, and
  it's already de-risked by the [observer spike](https://github.com/waviisoft/covsel/tree/main/spikes/observer).
- **Level 1 — per-_test_.** Snapshot V8 coverage before/after each test via the
  inspector and diff. Selects individual tests/scenarios. Needs one thin
  lifecycle shim per runner.

## The two decisions that determine quality

1. **Granularity = hash blocks, not line numbers.** Fingerprint methods/blocks
   by content hash so the map survives reformatting and line shifts.
2. **Fail open, loudly.** See [the fail-open guarantee](/guide/fail-open).

## Packages

| Package                   | Purpose                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `covsel`                  | The CLI                                                                  |
| `@covsel/core`            | Observer · Mapper · Store · Selector · Policy + the versioned map schema |
| `@covsel/adapter-generic` | Level-0 wrap-any-command adapter                                         |
| `@covsel/adapter-*`       | Per-runner adapters (community contribution lane)                        |

The full founding plan lives in
[DESIGN.md](https://github.com/waviisoft/covsel/blob/main/DESIGN.md).
