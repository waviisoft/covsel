# Getting started

::: warning Status: pre-alpha
Selection commands are not available yet. Today the CLI ships only `--help` and
`--version`; the record/affected/run loop below is the **target UX**. Follow the
[roadmap](/guide/roadmap) for progress.
:::

## Requirements

- Node ≥ 22 (the V8 inspector and `NODE_V8_COVERAGE` are stable there)
- pnpm (via `corepack enable`) if you are working on covsel itself

## Try the CLI today

```bash
npx covsel --help
npx covsel --version
```

## Target UX

Once selection lands, the loop is zero-config to start:

```bash
# Record a full run and build the map
npx covsel record -- vitest run

# Print the tests affected by your working-tree diff
npx covsel affected

# Or just run them
npx covsel run -- vitest run
```

`covsel affected` prints; you pipe it. It works with any runner that accepts a
list of test files — which is all of them.

## Working on covsel

```bash
git clone https://github.com/waviisoft/covsel
cd covsel
pnpm install
pnpm build && pnpm test
pnpm lint && pnpm typecheck
```

See [CONTRIBUTING.md](https://github.com/waviisoft/covsel/blob/main/CONTRIBUTING.md)
for how to write an adapter — the primary community contribution surface.
