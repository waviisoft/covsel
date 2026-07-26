# Roadmap

Work is tracked in the open on GitHub. For live status — what's in progress and
what's up for grabs — see the
[issue tracker](https://github.com/waviisoft/covsel/issues). This page is the
high-level shape; [`DESIGN.md`](https://github.com/waviisoft/covsel/blob/main/DESIGN.md)
has the full architecture.

## Now — selection, shipped

The end-to-end loop works, from whole-file down to individual tests:

- Observer for `NODE_V8_COVERAGE` process mode, Mapper from coverage to your
  source globs, a local Store, a git diff helper, a Selector, and the fail-open
  Policy (sentinels, new-test detection).
- Function-level (block-hash) selection, so editing one function only runs the
  tests that executed it and reformatting runs nothing.
- Per-test selection via inspector snapshot-diff observation: individual tests
  for node:test, individual **scenarios** for cucumber-js.
- Adapters: the generic wrap-any-command adapter, Vitest, node:test, cucumber-js.
- CLI: `record`, `affected`, `run`, `status`.

Editing one source selects only the tests that execute it; editing a sentinel
selects everything; a brand-new test always runs — proven end-to-end in CI by
the [examples](https://github.com/waviisoft/covsel/tree/main/examples).

## Next — more adapters and the CI story

- Adapters for Jest, Mocha, and Playwright.
- CI story: publish the map on the default branch, fetch the merge-base map on a
  PR, and merge shard maps; Stores for the GitHub Actions cache and S3/GCS.
- An adapter conformance kit so community adapters can prove themselves.
- `covsel watch`.

## Beyond — bundlers, monorepos, ecosystem

- Bundler source-map plugins (Turbopack/webpack/esbuild/Vite) for browser
  coverage.
- Compose with Nx/Turbo project graphs.
- fs-read tracking for non-JS dependencies.
- An optional remote map service.
