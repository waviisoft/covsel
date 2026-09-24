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

**Never include browser-executed or statically-served code in `observes`.**
A harness that drives a browser — Playwright for Python, Selenium, anything
pointed at a page — exercises client-side JavaScript that runs _in the
browser_, never inside the Node server process this adapter's inspector
session watches. The same is true of any file the server merely hands out as
a static asset. Declaring such a path anyway (`"observes": ["src/**"]` when
`src/public/**` is served to the browser and executed there, not on the
server) is not a smaller scope than the truth, it is a _wrong_ one: it claims
the recording saw code it never ran through, so an edit there would show "no
affected tests" instead of falling open to a full run — exactly the failure
this adapter exists to avoid. Keep client-side code out of `observes`
entirely, e.g.:

```json
{
  "harness": {
    "server": { "observes": ["src/**"] }
  }
}
```

with `src/public/**` (or wherever your project serves browser-executed code
from) left out on purpose, so a change there always falls open to a full run
rather than being silently — and wrongly — claimed as covered.

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

A test's id is ordinarily the repo-relative path `covsel` discovers it under
via `testGlobs` — a real file on disk your harness's own id space has to
agree with, one per scenario. It does not have to be one, though: set
top-level `inventory.command` (from `@covsel/core`, independent of this
adapter — see [Tests that aren't files in this
repository](/guide/getting-started#tests-that-arent-files-in-this-repository))
to a command that prints every scenario's id and, where you track one, an
opaque version:

```json
{
  "adapter": "harness",
  "harness": { "run": "--only {id}", "server": { "observes": ["src/**"] } },
  "inventory": { "command": "node harness/inventory.mjs" }
}
```

An id the inventory names is part of the suite even when no file matches
`testGlobs` at all — `testGlobs` itself can be left unset for a suite that is
_entirely_ inventory-defined, the ordinary shape for an acceptance harness
whose scenarios are pinned from another repository or a test-management
system, never files here. This adapter's own recorders declare
`Recorder.recordsInventoryIds`, which is what lets `covsel record` ask about
such an id at all — a generic runner-wrapping adapter cannot, since it would
hand the id straight to a runner expecting a real file, so core only asks a
recorder that opted in.

Selection then narrows exactly the way it does for an ordinary test file: a
scenario whose own version moved since the recording runs on its own,
without forcing the rest of the suite along with it; one that is unchanged,
with nothing in its recorded coverage affected by the diff either, is not
selected; a scenario new to the inventory always runs; and a different
`source` — the harness's own identity — is read the way a sentinel is,
running the whole suite. `examples/harness-basic`'s `spec:mul` scenario has
no anchor file at all and demonstrates every one of these end to end.

## Record → affected → run

**A full run's completeness depends on your harness's own bare invocation.**
When nothing is affected — or when a change forces a full run — covsel invokes
the command you gave it with no `--only`/`--select` args at all, exactly as
you would run it by hand; the adapter's own selection narrowing never enters
into that path. That means a full run is only actually complete when your
harness's _default_, no-arguments invocation runs every scenario your
inventory names, including any virtual (non-file) ones — if your harness's
bare command runs some narrower default suite, a "full run" covsel triggers
would silently be narrower than the suite covsel believes it recorded.
Confirm this about your own harness before relying on selection here.

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

If a test never reports `/end` — a genuinely stuck harness or application,
not a slow test — covsel gives up on it after `harness.boundary.testTimeoutMs`
(ten minutes by default) and fails the recording rather than waiting
forever. Raise it for a suite with legitimately longer individual tests;
`harness.boundary.timeoutMs` is a separate, much shorter bound on the
inspector round trips around each window, not on the test itself. When it
fires, covsel kills the entire harness process tree, not just the process it
spawned directly, so a harness that is itself a wrapper script or forks its
own children is actually stopped. The same watchdog exists in **one
invocation per test** mode too, bounded by `harness.testTimeoutMs` (the same
ten-minute default): a harness invocation that hangs there is killed the
same way, since there is no cooperating harness in that mode to time out a
single test against.

### Coverage that outlives the response: `settleMs`

Both recording modes close a test's coverage window the moment the harness
says the test is done — `/end`, or the process exiting. A real server
sometimes keeps working _after_ it has already responded to the client (a
fire-and-forget `.then()`, a scheduled callback fired from the response
handler); that work happens outside the window and is invisible to covsel,
so an edit to the file it exercises can wrongly show as unaffected.

Set `harness.server.settleMs` to delay the close by that many milliseconds:

```json
{ "harness": { "server": { "observes": ["src/**"], "settleMs": 200 } } }
```

**This is a mitigation, not a guarantee.** Work that finishes within
`settleMs` of the window's ordinary close is attributed to the test that was
open; anything that finishes after that is attributed to no test at all, and
covsel has no way to detect this from outside the harness — nothing here
observes whether the server is still busy. Unset or `0`, the default, changes
nothing: don't set it unless you know your server does this, and size it to
the slowest such callback you actually have, not as a general-purpose safety
margin.

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
  tests a server change breaks;
- **`inventory.command` is configured and could not be produced** — a
  suite that leans on it to know a scenario changed cannot be recorded
  against a version it never actually read.

## A runnable example

`examples/harness-basic` is a complete, CI-driven example: a small Node HTTP
server, and a Python harness driving it, wired for both recording modes —
including the reference boundary-protocol client, `covsel_boundary.py` — and
a per-scenario test inventory (`harness/inventory.mjs`). One of its three
scenarios, `spec:mul`, has no anchor file under `testGlobs` at all, and the
example demonstrates it recording and narrowing exactly like the other two:
an unchanged scenario skipped, one whose own version moved selected on its
own, a brand new id run, and a moved harness identity running the whole
suite.
