---
'@covsel/adapter-harness': minor
'@covsel/core': minor
'@covsel/adapter-playwright': patch
'@covsel/conformance': patch
'covsel': patch
---

Add `@covsel/adapter-harness`: selection for a test harness in any language that
drives a Node application from outside -- over HTTP, a browser, an MCP client,
anything -- recorded from the application server's own inspector.

The test process is never Node, so neither the generic adapter's
`NODE_V8_COVERAGE` wrap nor any per-runner adapter can see what a Python harness,
a Go test binary, or a Gherkin runner in another language executes. All the
application code such a harness exercises runs in the **server**, and this
adapter records that, reusing the Playwright adapter's server-window mechanism --
now shared from `@covsel/core` as `RemoteCoverageSession`, so a second adapter
could reuse it without depending on another adapter, which this repo's own
conventions forbid.

Two ways to find test boundaries, both supported:

- **One invocation per test.** covsel runs the harness once per discovered id,
  needing nothing from it. Slow -- every invocation pays the harness's own
  start-up cost -- but works for a harness nobody has touched.
- **The boundary protocol, one invocation.** Set `harness.boundary`, and covsel
  starts an HTTP server, sets `COVSEL_BOUNDARY`, and spawns the harness's plain,
  unfiltered command. A cooperating harness posts `/begin` and `/end` around
  each test and waits for covsel's acknowledgement, so the full run CI already
  does can also be the recording -- the only way recording costs no extra
  runner-minutes. The protocol is documented as a spec any language can
  implement, with a reference client (`covsel_boundary.py`) in
  `examples/harness-basic`.

covsel does not guess the harness's selection flag. `harness.run` names it as a
template appended to the base command, with `{id}` (repeated once per selected
test) or `{ids}` (one comma-joined token) marking where the id goes:

```json
{
  "adapter": "harness",
  "harness": {
    "run": "--only {id}",
    "server": { "observes": ["src/**"] }
  }
}
```

An empty selection never runs the bare command -- core already refused that for
every adapter, and this one's `runSelection` does too, since nothing stops a
future caller from reaching it directly.

Fail-open rules carry over unchanged: a test the run never reported, a red test,
an unreachable inspector, or a boundary-protocol violation (two tests
overlapping, an `end` naming a test that was not open) all fail the whole
recording. A test that never reports `/end` -- a stuck harness or application,
not a slow test -- fails the recording after `harness.boundary.testTimeoutMs`
(ten minutes by default) rather than hanging `covsel record` forever.

The harness's own code (step definitions, page objects, a spec pinned from
another repository) is not observed either, and a change there can change
what a test does with no application change at all. `@covsel/core`'s new
`inventory.command` (see its own changeset) gives that a narrower answer than
a blanket sentinel: a command that reports each scenario's id and an opaque
version lets covsel select just the scenario whose version moved, instead of
running the whole suite on every change to whatever defines it -- and this
adapter's recorders declare the new `Recorder.recordsInventoryIds`, so a
scenario that is _entirely_ inventory-defined -- not a file in this repository
at all, the ordinary shape for an acceptance suite pinned from elsewhere --
can be recorded and selected exactly like an ordinary test file, rather than
needing its own anchor file the way it would with any other adapter.
`examples/harness-basic`'s `spec:mul` scenario demonstrates it end to end: an
unchanged scenario skipped, one whose own version moved selected on its own,
a brand new id run, and a moved harness identity running the whole suite.

Three small additions elsewhere make this possible without coupling adapters
to each other or hardcoding a fixed CLI convention:

- `CovselConfig` gains `harness`, an object opaque to core and owned entirely by
  `@covsel/adapter-harness` -- but still compared like every other field, so a
  project that changes its selection flag or its server's `observes` without a
  new recording does not go on trusting a map recorded under the old meaning of
  either.
- `SelectionRunInit` (what a `runSelection` capability is called with) gains an
  optional `config`, for an adapter whose native narrowing is itself
  project-configurable rather than a fixed convention every project shares.
  Every caller in this codebase now supplies it.
- `Recorder` gains `recordsInventoryIds`, declared only by a recorder whose
  `record`/`recordRun` already treat every id as an opaque string handed to
  its own runner rather than a path it reads or executes -- never automatic,
  since asking a generic runner-wrapping adapter (or Vitest's, Jest's,
  Mocha's) to record a virtual id would fail its underlying command rather
  than skip it safely. `recordMap`/`selectAffected`/`covsel status` all
  refused a suite with nothing matching `testGlobs` outright before this,
  even with a real inventory to record from -- the gap #126 explicitly left
  for whichever adapter actually needed it to decide how it closes.
