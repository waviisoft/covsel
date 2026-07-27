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
- A CI story: publish the map on the default branch, restore it on pull requests,
  and merge the maps from a sharded suite — see [Using covsel in CI](/guide/ci).
  The store is a directory, so GitHub Actions caching covers it with no extra
  moving parts.
- An adapter conformance kit every adapter runs, so a community adapter can prove
  itself — see [Writing an adapter](/guide/adapters/writing-an-adapter).
- CLI: `record`, `affected`, `run`, `status`, `merge`.

Editing one source selects only the tests that execute it; editing a sentinel
selects everything; a brand-new test always runs — proven end-to-end in CI by
the [examples](https://github.com/waviisoft/covsel/tree/main/examples).

## Next — more adapters

- Adapters for Jest, Mocha, and Playwright.
- `covsel watch`.

## Beyond — bundlers, monorepos, ecosystem

- Bundler source-map plugins (Turbopack/webpack/esbuild/Vite) for browser
  coverage.
- Compose with Nx/Turbo project graphs.
- Remote Stores (S3/GCS), if teams outgrow caching the store directory.
- fs-read tracking for non-JS dependencies.
- An optional remote map service.
