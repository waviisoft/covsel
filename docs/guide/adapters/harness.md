# External harness adapter

`@covsel/adapter-harness` brings selection to a test harness that lives
outside the JS toolchain entirely and drives a Node application from
**outside** — over HTTP, a browser, an MCP client, or anything else. A
Python harness (pytest, Playwright for Python), a Go or Rust test binary, k6,
Postman/Newman, a Gherkin runner in another language: none of them are Node,
so neither the [generic adapter](/guide/adapters/generic)'s
`NODE_V8_COVERAGE` wrap nor any per-runner adapter can see what they execute.
All the application code they exercise runs in the **server**, and this
adapter records that, over the server's own inspector — the same mechanism
the [Playwright adapter](/guide/adapters/playwright) uses for its server
window.

## What it observes, and what it does not

The harness process itself is never observed — it is not Node, and covsel
has no way to run anything inside it. Only the application **server**, over
its inspector, is. Declare what that server actually executes:

```json
{
  "adapter": "harness",
  "harness": {
    "run": "--only {id}",
    "server": { "observes": ["src/**"] }
  }
}
```

There is no default, and none would be honest: `**` would claim the
recording watched everything a full run would, and `[]` would make the
recording useless. Declare a path only when, had code there run, the
recording would have seen it — including the server's own entry script, if
it does anything beyond starting up. Everything outside `observes` falls
open to a full run on change, exactly as every other adapter's scope does.

The harness's own code — step definitions, page objects, whatever drives the
protocol — is not observed either. A change there can change what a test
does with no application change at all, so put it under `sentinels`:

```json
{ "sentinels": ["package.json", "pnpm-lock.yaml", "harness/**"] }
```

## The run template

covsel cannot guess your harness's selection flag, so `harness.run` names it:
a fragment appended to the command you give `covsel record`/`covsel run`,
with a placeholder for the id (or ids) to run.

```json
{ "harness": { "run": "--only {id}" } }
```

- **`{id}`** repeats the flag in front of it once per selected test:
  `--only a --only b`.
- **`{ids}`** takes the whole selection as one comma-joined token instead:
  `--select a,b`. Use it for a harness whose flag takes a list rather than
  repeating.

Use exactly one of the two. An empty selection never runs the bare command —
covsel refuses that before it ever reaches the adapter, because a bare
command is a full run, and a full run silently standing in for "nothing
affected" is exactly the failure this adapter exists to avoid.

A test's id, for now, is the repo-relative path `covsel` discovers it under
via `testGlobs` — a real file on disk your harness's own id space has to
agree with, one per scenario. covsel does not yet have a way to take test
ids and per-test versions from an external inventory (tracked as
[issue #123](https://github.com/waviisoft/covsel/issues/123)); until it
does, a harness whose tests are not files in this repository — a spec
tracked in a separate repository, say — has to be covered by a sentinel on
whatever defines it, which means a full run on every change to it.

## Record → affected → run

The application server has to already be running, with its inspector open,
before you record — this adapter only ever connects to it, exactly as the
Playwright adapter's server window does, and never starts or stops it
itself:

```bash
node --inspect=9229 server.js &

npm install --save-dev covsel @covsel/adapter-harness
covsel record -- python3 harness/run.py

covsel affected
covsel run -- python3 harness/run.py
```

`covsel run` invokes your harness once, with `harness.run`'s template
expanded over the affected ids appended to the command you gave it.

## Two ways to record

### One invocation per test

The default, and the one that needs nothing from the harness: covsel runs
your harness once per discovered test id, exactly as a selected run would
invoke it for that one id, opening a fresh coverage window around each
invocation. It is slow — every invocation pays the harness's own start-up
cost — but it works for a harness nobody has touched.

### The boundary protocol

Set `harness.boundary` to record with one invocation instead, letting the
full run your CI already does on the default branch also be the recording —
the only way recording costs no extra runner-minutes:

```json
{
  "harness": {
    "run": "--only {id}",
    "server": { "observes": ["src/**"] },
    "boundary": {}
  }
}
```

covsel sets `COVSEL_BOUNDARY` and spawns your harness's plain, unfiltered
command; a harness that reads the variable announces each test's start and
end and waits for covsel's acknowledgement before continuing, so covsel can
open and close the coverage window exactly at the boundary. A harness that
does not read the variable simply runs as it always has, which is what
makes it safe to build into a harness permanently. See
[the boundary protocol](/guide/adapters/boundary-protocol) for the wire
format and a reference client.

## Serial recording, and shared server state

One application process, one test at a time, for the whole recording — the
same requirement the Playwright adapter's server window has. A harness that
registers users or writes data per test pushes the server through code
paths that depend on what earlier tests left behind; that is a property of
your harness and your application, not something this adapter changes.

Selected runs afterwards are unconstrained: they can be parallel or sharded
however your harness already supports.

## What fails the recording

Recording is all-or-nothing. It fails, and writes nothing, when:

- **the harness exited non-zero** for an invocation — a test that did not
  pass cannot be recorded, because it may have stopped before running the
  part of itself its coverage is really about;
- **a test the run never reported** — under either recording mode, an id
  discovered but never mentioned in the result cannot be told apart from one
  that covered nothing, which selection would read as "no test to run";
- **the boundary protocol was violated** — two tests overlapping, or an
  `end` naming a test that was not open — because the coverage window that
  was interrupted cannot be trusted for either test;
- **the server's inspector could not be reached** — an unobserved server
  behind a scope that claims otherwise is exactly the map that skips the
  tests a server change breaks.

## A runnable example

`examples/harness-basic` is a complete, CI-driven example: a small Node HTTP
server, and a Python harness driving it, wired for both recording modes —
including the reference boundary-protocol client, `covsel_boundary.py`.
