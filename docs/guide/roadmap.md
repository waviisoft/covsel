# Roadmap

Work is tracked in the open on GitHub. For live status — what's in progress and
what's up for grabs — see the
[issue tracker](https://github.com/waviisoft/covsel/issues). This page is the
high-level shape; [`DESIGN.md`](https://github.com/waviisoft/covsel/blob/main/DESIGN.md)
has the full architecture.

## Now — foundations

The repo, toolchain, and CI are in place. The map schema is defined and
versioned, the layer interfaces are published from `@covsel/core`, and the CLI
shell (`--help` / `--version`) ships. An integration test proves the Level-0
coverage-observation mechanism.

## Next — file-level selection (the MVP)

The first end-to-end loop, at per-file granularity with zero runner integration:

- Observer for `NODE_V8_COVERAGE` process mode, Mapper from coverage to your
  source globs, a local Store, a file-level Selector, and the fail-open Policy
  (sentinels, new-test detection).
- The generic wrap-any-command adapter and a first Vitest adapter.
- CLI: `record`, `affected`, `run`, `status`.

**Done when:** editing one source file selects only the test files that execute
it; editing a sentinel selects everything; a brand-new test always runs.

## Later — per-test precision and real adapters

- Inspector snapshot-diff observation for per-test granularity.
- Block-hash granularity so the map survives reformatting and line shifts.
- Adapters for Jest, Mocha, node:test, cucumber-js, and Playwright.
- CI story: publish the map on the default branch, fetch the merge-base map on a
  PR, and merge shard maps; Stores for the GitHub Actions cache and S3/GCS.
- `covsel watch`.

## Beyond — bundlers, monorepos, ecosystem

- Bundler source-map plugins (Turbopack/webpack/esbuild/Vite) for browser
  coverage.
- Compose with Nx/Turbo project graphs.
- fs-read tracking for non-JS dependencies.
- An optional remote map service.
