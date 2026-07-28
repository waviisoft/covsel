# Getting started

Selection ships today: `covsel record`, `affected`, `run`, `watch`, `status`,
and `merge` -- with function-level (block-hash) precision, per-test selection for
node:test, and scenario-level selection for cucumber-js. Running covsel in CI is
covered in the [CI guide](/guide/ci).

## Requirements

- Node >= 22 (the V8 inspector and `NODE_V8_COVERAGE` are stable there)
- pnpm (via `corepack enable`) if you are working on covsel itself
- For Vitest, `@vitest/coverage-v8` in your project (see the
  [Vitest adapter](/guide/adapters/vitest))

## Install

covsel ships no adapters, so install the CLI and the one for your runner. Which
one is the only decision here, and [Adapters](/guide/adapters/) has the full
picture:

```bash
npm install --save-dev covsel @covsel/adapter-generic   # any command, whole-file
npm install --save-dev covsel @covsel/adapter-vitest    # Vitest
npm install --save-dev covsel @covsel/adapter-jest      # Jest
npm install --save-dev covsel @covsel/adapter-node-test # node:test, per test
npm install --save-dev covsel @covsel/adapter-cucumber  # cucumber-js, per scenario
```

Adapters are separate packages because most projects need exactly one: bundling
five runners' worth of code into every install would make you carry four you
will never load. A name covsel does not find is reported with the package to
install, so a missing one is never a mystery.

## The loop

```bash
# 1. Record: build the test -> covered-source map (one process per test file)
covsel record -- node --test
covsel record --adapter vitest -- vitest run   # needs @vitest/coverage-v8
covsel record --adapter jest -- jest           # coverage is built into Jest

# 2. Affected: print the test files your working-tree diff can affect
covsel affected
covsel affected --since origin/main

# 3. Run: run only those tests by wrapping the runner
covsel run -- node --test

# 4. Watch: keep running the affected tests as you edit
covsel watch -- node --test
```

[Watch mode](/guide/watch) drives the same selection continuously — one run per
save, debounced, falling open to a full run whenever it cannot tell what a
change affects.

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
  use the [generic adapter](/guide/adapters/generic), which wraps any command
  and is what `--adapter` defaults to.
- **Runners that transform sources** (Vitest, Jest) need a runner-specific
  adapter, because raw process coverage can't see transformed code. See
  [Adapters](/guide/adapters/) for the full picture.

## Configuration

Selection needs no configuration once an adapter is installed. To refine, add a `.covsel.json` (or
`covsel.config.js`) at your repo root:

```jsonc
{
  "testGlobs": ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  "sourceGlobs": ["**/*"], // repo minus node_modules/dist/coverage/.covsel and tests
  "alwaysRun": ["**/fixtures/**"], // test files that must always run
  "sentinels": ["package.json", "pnpm-lock.yaml", "tsconfig*.json"],
  "granularity": "block", // "block" (function-level) | "file"
  "store": { "dir": ".covsel" },
}
```

Any change matching `sentinels` forces a full run; see
[the fail-open guarantee](/guide/fail-open).

### Bundled code

If your tests exercise their sources through a bundle, covsel needs the build's
source maps to know what that bundle is — a script it cannot map back to a
source fails the recording rather than crediting nothing. Build with source maps
on, and tell covsel where to find the assets when the runner only ever names
them by URL:

```jsonc
{
  "sourceMaps": {
    // Serve-time URLs → the directory holding the built assets.
    "buildDirs": [{ "urlPrefix": "http://localhost:5173/", "dir": "dist" }],
    "http": true, // fetch scripts and maps that are not on disk
    "allowUnmappable": [], // scripts you accept never being able to map
  },
}
```

### Granularity

At the default `block` granularity, covsel records which **functions** each test
executed (fingerprinted by content hash, so reformatting and line shifts don't
matter). Editing one function then selects only the tests that actually ran it,
even when several tests import the same file; a top-level edit, or anything
covsel can't parse into blocks, falls back to selecting every test on that file.
Set `"granularity": "file"` to record and select at whole-file granularity only.

## Working on covsel

```bash
git clone https://github.com/waviisoft/covsel
cd covsel
pnpm install
pnpm build && pnpm test
pnpm lint && pnpm typecheck
```

See [CONTRIBUTING.md](https://github.com/waviisoft/covsel/blob/main/CONTRIBUTING.md)
for how to write an adapter -- the primary community contribution surface.
