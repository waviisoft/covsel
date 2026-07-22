# Adapters

An **adapter** is the only runner-specific part of covsel. Everything else — the
map schema, the selector, the fail-open policy — is shared. An adapter does two
things:

1. **Observe** which source files a test file executes, so `covsel record` can
   build the map.
2. **Format** a selection as the runner's input (at file level, a plain list of
   test files).

Adapters depend on `@covsel/core` only. Selecting one is a single flag:

```bash
covsel record --adapter vitest -- vitest run
```

With no `--adapter`, covsel uses the **generic** adapter.

## How covsel observes coverage

At file granularity there are two ways to learn which sources a test file ran,
and which one an adapter uses depends on the runner:

- **`NODE_V8_COVERAGE` process mode** (the [generic](/guide/adapters/generic)
  adapter). Run one test file in its own process with `NODE_V8_COVERAGE` set and
  read the raw V8 dump. This works when the runner **executes your source
  directly**, so the coverage records real `file://` paths — for example
  `node --test`, or Mocha on plain JavaScript.

- **The runner's own coverage report** (the [Vitest](/guide/adapters/vitest)
  adapter). Runners that **transform sources before executing them** (Vitest via
  vite-node, Jest via its transformer) evaluate the transformed code through
  their own module loader, so raw `NODE_V8_COVERAGE` never sees your `src/**`.
  For these, the adapter enables the runner's built-in V8 coverage, which remaps
  execution back to your sources through the runner's source maps, and reads the
  resulting report.

Both produce the same thing: the set of source files a test executed. The rest
of covsel is identical regardless of which path recorded the map.

## Available adapters

| Adapter                     | Runner                  | How it records                     | Status  |
| --------------------------- | ----------------------- | ---------------------------------- | ------- |
| `@covsel/adapter-generic`   | any direct-exec command | `NODE_V8_COVERAGE` process         | shipped |
| `@covsel/adapter-vitest`    | Vitest                  | Vitest's own V8 coverage           | shipped |
| `@covsel/adapter-node-test` | node:test               | inspector snapshot-diff (per-test) | shipped |
| _(planned)_                 | Jest                    | Jest's own coverage                | later   |
| _(planned)_                 | Mocha · cucumber-js · … | generic wrap / lifecycle shim      | later   |

The generic and Vitest adapters record at whole-file granularity; the node:test
adapter records each **test** individually and runs only the affected tests.

## Writing an adapter

Adapters are the primary community contribution surface. Each implements the
`Adapter` interface from `@covsel/core` and, for a transforming runner, a
recorder that produces the executed source list. See
[CONTRIBUTING.md](https://github.com/waviisoft/covsel/blob/main/CONTRIBUTING.md)
and the [architecture](/guide/architecture) page.
