# Vitest adapter

`@covsel/adapter-vitest` records per-file coverage for [Vitest](https://vitest.dev)
suites.

## Why a dedicated adapter

Vitest evaluates your code through vite-node: sources are transformed and run by
Vitest's own module runner, not imported as ordinary files. As a result, raw
`NODE_V8_COVERAGE` at the process boundary contains **no `file://` script for
your `src/**`** — only things Vitest imports normally, like `vitest.config.ts`,
show up. The generic wrap therefore cannot attribute Vitest coverage.

Instead, this adapter enables **Vitest's own V8 coverage provider**, which
remaps execution back to your original sources through Vite's source maps, and
reads the resulting `coverage-final.json`. That gives precise per-file
attribution.

## Setup

```bash
covsel init
```

installs the adapter and `@vitest/coverage-v8` together, because the adapter
records through that provider and would fail at the first `record` without it.

Installing by hand, the provider comes along as a peer dependency under npm, and
pnpm and yarn will tell you it is missing:

```bash
npm install -D @covsel/adapter-vitest @vitest/coverage-v8
# or: pnpm add -D @covsel/adapter-vitest @vitest/coverage-v8
```

Its version should track your Vitest version. No `vitest.config.ts` changes are
required — the adapter passes the coverage flags it needs on the command line.

## Record → affected → run

```bash
# Build the map with the vitest adapter
covsel record --adapter vitest -- vitest run

# Print the test files your working-tree diff can affect
covsel affected

# Run only those
covsel run --adapter vitest -- vitest run   # or: vitest run $(covsel affected)
```

Under the hood, `record` runs `vitest run <file>` once per test file with V8
coverage enabled and a JSON reporter, then keeps the sources that file actually
executed.

## Notes

- Requires `@vitest/coverage-v8`. Without it, `record` refuses before running
  anything and names the install command — Vitest would otherwise run the whole
  suite and simply write no report, and an entry crediting nothing would read as
  a test that covers nothing.
- Granularity is per **file**: editing a source runs every test in a file that
  executed it.
- A runnable end-to-end example lives in
  [`examples/vitest-basic`](https://github.com/waviisoft/covsel/tree/main/examples/vitest-basic).
