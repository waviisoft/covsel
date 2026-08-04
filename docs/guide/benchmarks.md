# Benchmarks

covsel's claim is that runtime coverage selects more precisely than a static
import graph, and never skips a test a change could affect. Both halves are
measurable, so this page is about measuring them on real repositories rather
than on fixtures written to make covsel look good.

The harness lives in
[`benchmarks/`](https://github.com/waviisoft/covsel/tree/main/benchmarks).

## What gets measured

Three things, in order of how much they matter.

**Misses.** Test files whose pass/fail outcome a change altered, that selection
did not run. This is the only number that can fail a benchmark run, because it
is the failure covsel exists to prevent. It is established by running the whole
suite at the base commit and again at the head, and comparing per-file verdicts:
any file whose outcome moved must have been selected.

**Selection.** How much of the suite ran. Reported split by what put each file
there — coverage, or a fail-open rule such as a changed test file, an
`alwaysRun` glob, or an entry that credits no source. Reporting one number for
both would make a fail-open improvement look like a precision regression: a
release that starts always running tests it cannot reason about selects strictly
more, and a benchmark counting only files would call that worse.

**Time.** The selected run against the full run, with deciding counted in, plus
what recording cost and how many selections it takes to pay that back. A speedup
published without its recording cost is not a result, it is an advertisement.

## How a replay works

A project pins a base commit. The map is recorded there once and carried across
to each replayed head untouched — which is what
[CI](/guide/ci) does with a map published from the default branch.

No diff window is passed. Selection measures from the commit the map records, so
computing a window by hand would be a second opinion about it, and the wrong one
if the two ever disagreed.

```bash
pnpm build
pnpm --filter @covsel/benchmarks build

node benchmarks/dist/cli.js \
  --project benchmarks/projects/fastify.json \
  --head <commit>
```

Each replay appends one JSON line to `benchmarks/results/<project>.jsonl`. A
miss exits non-zero.

### Establishing outcomes

Each test file runs in its own process and its exit status is the verdict. Every
runner reports differently and the oracle needs the same answer from all of
them; an exit status is the one signal they all give, so this needs no
per-runner parsing.

Those runs are deliberately **not** where timings come from — a process per file
measures process startup as much as it measures the suite. Wall-clock numbers
come from whole-suite runs instead.

### Why not compare against a file-level oracle

An "expected set" built from the files each test covers is wider than the right
answer at block granularity: a test covering a changed file is correctly left
out when the blocks it actually executed did not change. Measured on covsel's
own suite, a narrow edit had covsel correctly select 4 of 37 test files while a
file-level oracle called 17 of them missing. Asking what a change _broke_, as
the miss oracle does, avoids that trap; asking what it _touched_ does not.

## Measured so far

Two projects, both through the generic wrap with no runner integration, on
Node 22. Each edits a single function body and compares what block granularity
selected against what file granularity would have.

|                                | [express](https://github.com/expressjs/express) | [fastify](https://github.com/fastify/fastify) |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------- |
| Runner                         | Mocha, plain JS                                 | node:test, plain JS                           |
| Test files                     | 91                                              | 193                                           |
| Full suite                     | 3.8s                                            | 45.3s                                         |
| File granularity would select  | 87 (96%)                                        | 185 (96%)                                     |
| **Block granularity selected** | **13 (14%)**                                    | **33 (17%)**                                  |
| Selected run                   | 1.6s                                            | **11.0s**                                     |
| Recording                      | 51.6s                                           | 2m54s                                         |

The shape is the same in both: **file-level selection picks almost the whole
suite**, because every test in a web framework loads essentially all of `lib/`.
Block granularity is what turns that into a result.

Three things this does not say:

- **express shows no time saving worth having.** Its whole suite is under four
  seconds and recording costs thirteen times that. Precision is real there;
  speed is not. A project only benefits when its suite is slow enough that the
  saving outruns what recording cost.
- **These timings are machine-dependent.** The same fastify suite measured 38.3s
  and 45.3s for identical work on one container. Selection counts are
  deterministic and comparable across machines; wall-clock is not.
- **Neither is a replay of a real change.** They are single-function edits, which
  isolate granularity but do not tell you what selection does against the
  distribution of changes a project actually merges. That is what the replay
  harness is for, and those results are not collected yet.

## Adding a project

Projects are JSON in
[`benchmarks/projects/`](https://github.com/waviisoft/covsel/tree/main/benchmarks/projects),
so adding one is a pull request against a data file. The fields are validated
before anything is cloned.

Globs must contain a `/`. A slash-less glob is also matched against a path's
basename anywhere in the tree, so `sourceGlobs: ["index.js"]` silently grows to
every `index.js` in the repository — write `./index.js`, or `**/index.js` if you
did mean all of them.

One practical warning from the projects already tried: recording drives one
process per test file and waits for each, so a test file that hangs stalls
recording for as long as it is allowed to. The harness passes recording's
progress through and puts a ceiling on it (`--record-timeout`), so a stall names
the file it stopped on instead of going quiet.
