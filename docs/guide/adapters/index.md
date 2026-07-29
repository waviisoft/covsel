# Adapters

An **adapter** is the only runner-specific part of covsel. Everything else -- the
map schema, the selector, the fail-open policy -- is shared. An adapter is a
single object implementing the `Adapter` interface from `@covsel/core`, and it
does two things:

1. **Observe** which source files a test file executes, so `covsel record` can
   build the map.
2. **Format** a selection as the runner's input (at file level, a plain list of
   test files) -- or, where the runner can be narrowed below file level, run that
   selection itself.

Adapters depend on `@covsel/core` only.

## Installing one

**covsel ships no adapters.** Install the one your runner needs alongside the
CLI, then name it:

```bash
npm install --save-dev covsel @covsel/adapter-vitest
covsel record --adapter vitest -- vitest run
```

With no `--adapter`, covsel uses the name `generic` -- which still means
`@covsel/adapter-generic` has to be installed. Nothing is bundled, so most
projects carry exactly the adapter they use instead of five runners' worth of
code they don't.

A name is resolved to a package by convention: `--adapter mocha` looks for
`@covsel/adapter-mocha`, then `covsel-adapter-mocha`. A package named neither way
is selectable by writing the specifier out in full:

```bash
covsel record --adapter @acme/our-runner-adapter -- our-runner
```

Resolution happens from your project, so the adapter that loads is the one your
project installed, even when covsel itself is installed globally. Nothing is
privileged: the adapters listed below resolve through exactly the same path as a
third-party one, so you can pin, fork, or replace any of them.

An adapter that resolves but is not really an adapter is rejected before anything
is recorded, naming the capability it is missing. That is deliberate: covsel's
promise is that it never skips a test your change could affect, and a recorder
that silently produces nothing would record that your tests cover nothing -- which
would skip all of them on every diff afterwards.

## How covsel observes coverage

At file granularity there are two ways to learn which sources a test file ran,
and which one an adapter uses depends on the runner:

- **`NODE_V8_COVERAGE` process mode** (the [generic](/guide/adapters/generic)
  adapter). Run one test file in its own process with `NODE_V8_COVERAGE` set and
  read the raw V8 dump. This works when the runner **executes your source
  directly**, so the coverage records real `file://` paths -- for example
  `node --test`, or Mocha on plain JavaScript.

- **The runner's own coverage report** (the [Vitest](/guide/adapters/vitest) and
  [Jest](/guide/adapters/jest) adapters). Runners that **transform sources before
  executing them** (Vitest via vite-node, Jest via its transformer) evaluate the
  transformed code through their own module loader, so raw `NODE_V8_COVERAGE` at
  the process boundary cannot describe your `src/**` -- under Vitest it does not
  see them at all, and under Jest it names them but reports offsets into the
  transformed code. For these, the adapter enables the runner's built-in
  coverage, which remaps execution back to your sources through the runner's
  source maps, and reads the resulting report.

Both produce the same thing: the set of source files a test executed. The rest
of covsel is identical regardless of which path recorded the map.

## Available adapters

| Adapter (install separately) | Runner                  | How it records                     |
| ---------------------------- | ----------------------- | ---------------------------------- |
| `@covsel/adapter-generic`    | any direct-exec command | `NODE_V8_COVERAGE` process         |
| `@covsel/adapter-vitest`     | Vitest                  | Vitest's own V8 coverage           |
| `@covsel/adapter-jest`       | Jest                    | Jest's own coverage                |
| `@covsel/adapter-node-test`  | node:test               | inspector snapshot-diff (per-test) |
| `@covsel/adapter-cucumber`   | cucumber-js             | inspector snapshot-diff (scenario) |

The generic, Vitest, and Jest adapters record at whole-file granularity. The
node:test and cucumber-js adapters record each **test** or **scenario**
individually and run only the affected ones -- which for cucumber-js is the only
selection it has natively.

## Writing an adapter

Adapters are the primary community contribution surface. Each is one exported
object implementing the `Adapter` interface from `@covsel/core` -- identity,
selection formatting, and the recorder that produces the executed source list,
plus whatever optional capabilities the runner supports -- and proves itself
against the shared conformance suite in `@covsel/conformance`, the same suite
every adapter above runs. Nothing distinguishes one covsel publishes from one
you publish: both are packages a project installs, resolved the same way. See
[Writing an adapter](/guide/adapters/writing-an-adapter),
[CONTRIBUTING.md](https://github.com/waviisoft/covsel/blob/main/CONTRIBUTING.md),
and the [architecture](/guide/architecture) page.
