# Mocha adapter

`@covsel/adapter-mocha` brings **per-test** selection to
[Mocha](https://mochajs.org). Instead of selecting whole spec files, it records
what each individual test executed and runs only the tests a change can affect.

You do not need it to use covsel with Mocha. Mocha executes your source directly,
so the [generic adapter](/guide/adapters/generic) already records and selects it
at file level with no Mocha-specific code — that is what
[`examples/mocha-basic`](https://github.com/waviisoft/covsel/tree/main/examples/mocha-basic)
demonstrates end-to-end on every CI run. This package exists for the one thing
the generic wrap cannot do: narrowing a run below the file.

## How it records

Recording loads a **root hook plugin** through Mocha's own `--require`. The
plugin wraps every test with the per-test
[`InspectorObserver`](/guide/architecture), snapshotting V8 precise coverage in
the root `beforeEach` and diffing it in the root `afterEach`, so each test
becomes its own map entry.

The root hook plugin form is what makes the window trustworthy: its `beforeEach`
is the first hook Mocha runs before a test and its `afterEach` the last one
after, so the window encloses the test and every hook it depends on, and nothing
between two tests belongs to either.

Two details are worth knowing:

- Tests are recorded under their **full title** — the test's own title preceded
  by the titles of the suites around it — because that is what `--grep` matches.
- Recording always passes `--no-parallel`. Mocha's parallel mode runs your specs,
  and the root hooks with them, inside worker processes while the run's own
  process is the one covsel reads the result from, so a recording left in
  parallel mode comes back empty. Recording runs one spec file at a time and
  gains nothing from workers; your own `covsel run` command is untouched.

Per-test observation is at **source-file** granularity: V8 precise coverage
reports only the functions that actually ran, so it reliably identifies which
files a test executed. (Per-function precision within a shared file is left to
the whole-file recorders — see the [generic adapter](/guide/adapters/generic).)

## Setup

Install Mocha as usual — there is nothing extra to add:

```bash
npm install --save-dev covsel @covsel/adapter-mocha mocha
```

Specs are discovered automatically when you pass `--adapter mocha`: `test/**` with
the `js`, `cjs`, and `mjs` extensions, plus the `*.test.*` / `*.spec.*` convention
wherever those files live. That is deliberately wider than Mocha's own default
(the `test` directory, no subdirectories unless you pass `--recursive`), because a
spec covsel never discovers would sit out every narrowed run. Set `testGlobs` in
your covsel config if your specs live somewhere else entirely.

## Record → affected → run

```bash
# Build the map, one entry per individual test
covsel record --adapter mocha -- mocha

# Print the spec files the diff can affect (file-level, pipeable)
covsel affected --adapter mocha

# Run only the affected tests -- individual tests, via --grep
covsel run --adapter mocha -- mocha
```

When several tests live in one spec file but touch different sources, editing one
source runs only the test that executed it. `covsel run` invokes Mocha over the
affected files with a single `--grep` matching the affected tests' full titles;
titles are escaped, so one containing `+`, `(`, or `.` still matches rather than
compiling to a pattern that finds nothing. Two files holding the same title only
ever cause _more_ tests to run, so selection stays fail-open. Spec files that must
run in full — a new or changed spec — are run without a filter.
