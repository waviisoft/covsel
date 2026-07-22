# Getting started

File-level selection ships today: `covsel record`, `affected`, `run`, and
`status`. Block-hash granularity and per-test precision are on the
[roadmap](/guide/roadmap).

## Requirements

- Node ≥ 22 (the V8 inspector and `NODE_V8_COVERAGE` are stable there)
- pnpm (via `corepack enable`) if you are working on covsel itself
- For Vitest, `@vitest/coverage-v8` in your project (see the
  [Vitest adapter](/guide/adapters/vitest))

## The loop

```bash
# 1. Record: build the test → covered-source map (one process per test file)
covsel record -- node --test
covsel record --adapter vitest -- vitest run   # needs @vitest/coverage-v8

# 2. Affected: print the test files your working-tree diff can affect
covsel affected
covsel affected --since origin/main

# 3. Run: run only those tests by wrapping the runner
covsel run -- node --test
```

`covsel affected` prints a newline-separated file list, so you can also pipe it
into any runner that accepts test files:

```bash
node --test $(covsel affected)
```

### Inspect the map

```bash
covsel status
```

shows the store path, the map's age and size, whether any sentinel changed since
record, and whether the next `affected` would be a full run.

## Which adapter?

Selection is zero-config, but recording depends on how your runner executes
code:

- **Runners that execute source directly** (`node --test`, Mocha on plain JS)
  use the [generic adapter](/guide/adapters/generic) — the default, nothing to
  install.
- **Runners that transform sources** (Vitest) need a runner-specific adapter,
  because raw process coverage can't see transformed code. See
  [Adapters](/guide/adapters/) for the full picture.

## Configuration

Zero-config works out of the box. To refine, add a `.covsel.json` (or
`covsel.config.js`) at your repo root:

```jsonc
{
  "testGlobs": ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  "sourceGlobs": ["**/*"], // repo minus node_modules/dist/coverage/.covsel and tests
  "alwaysRun": ["**/fixtures/**"], // test files that must always run
  "sentinels": ["package.json", "pnpm-lock.yaml", "tsconfig*.json"],
  "store": { "dir": ".covsel" },
}
```

Any change matching `sentinels` forces a full run; see
[the fail-open guarantee](/guide/fail-open).

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
