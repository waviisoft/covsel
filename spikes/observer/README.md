# Observer spike — `NODE_V8_COVERAGE` per-file map

Proves the Level-0 contract with zero runner integration: each test file runs
in its own process with `NODE_V8_COVERAGE`, the V8 dump is parsed, and the
result is a correct `test file → covered source files` map — the shared helper
shows up under both tests, and neither test claims the other's source.

```bash
pnpm spike:observer
```

Findings that carry into the Milestone-1 Observer (issue #9):

- V8 dumps land as `coverage-*.json` on process exit; one process per test
  file gives clean attribution for free.
- Filtering: keep `file://` URLs only (drops node internals), then apply
  `sourceGlobs`. "Executed" at file level = any range with `count > 0`, which
  means _imported implies covered_ — the right semantics for file-level TIA.
- Multiple dump files can appear per process (workers); merge them.
