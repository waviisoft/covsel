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
- Adapters: the generic wrap-any-command adapter, Vitest, Jest, node:test,
  cucumber-js.
- A CI story: publish the map on the default branch, restore it on pull requests,
  and merge the maps from a sharded suite — see [Using covsel in CI](/guide/ci).
  The store is a directory, so GitHub Actions caching covers it with no extra
  moving parts.
- An adapter conformance kit every adapter runs, so a community adapter can prove
  itself — see [Writing an adapter](/guide/adapters/writing-an-adapter).
- CLI: `record`, `affected`, `run`, `watch`, `status`, `merge`.
- [Watch mode](/guide/watch): the same selection driven continuously, one
  debounced run per save.

Editing one source selects only the tests that execute it; editing a sentinel
selects everything; a brand-new test always runs — proven end-to-end in CI by
the [examples](https://github.com/waviisoft/covsel/tree/main/examples).

## Next — more adapters

- An adapter for Mocha.
- An adapter for Playwright, and with it UI test selection. This is the one
  adapter that cannot be a thin shim: a UI test executes in the browser and
  usually an application server, so recording it means observing several V8
  isolates and projecting bundled coverage back to your sources. Most of the core
  work that needs is done — unmappable scripts now fail recording, a recorder
  declares what it could not see, several observation windows fold into one unit,
  and conformance holds an adapter to its declared scope. Projecting bundled
  coverage ranges through source maps is the remaining piece. Until it ships, the
  generic wrap is not a substitute: it observes only the spec process, so the map
  would credit your tests with covering none of your app.

## Beyond — bundlers, monorepos, ecosystem

- Bundler source-map plugins (Turbopack/webpack/esbuild/Vite) for browser
  coverage.
- Compose with Nx/Turbo project graphs.
- fs-read tracking for non-JS dependencies.
