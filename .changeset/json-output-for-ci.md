---
'@covsel/core': minor
'covsel': minor
---

Answer `affected`, `status`, and `fetch` as data, with `--format json`.

Everything covsel says about a selection was prose meant for a person: `affected`
printed a file list, `status` an aligned report, `fetch` English sentences on
stderr. A CI job that wants to _report_ what covsel decided — a step output, a
job summary, a shard matrix — had to scrape those, and scraping breaks the first
time a sentence is reworded. This is the surface any CI integration, ours or
anyone else's, has to be built on.

- `--format json` on `affected`, `status`, and `fetch` writes one object on one
  line to stdout. The human lines stay on stderr, where `affected` and `fetch`
  already put them, so a job piping stdout into a parser keeps the log a person
  reads beside it. `status` is the exception and the object replaces its report,
  because that report _is_ its stdout and the two cannot share the stream.
- Exit codes do not depend on the format. `fetch` finding nothing is still
  `ok: false` and still exits 0 — the tests still have to run, and they run in
  full — and `--require` still turns that into a failure.
- A full run still enumerates every discovered test file; `fullRun` and `reason`
  are what say the list is not a selection. Emptying the lists there reads like
  tidiness and is the one shape that turns `covsel affected --format json | jq -r
'.files[]' | xargs <runner>` into a command that runs no tests, on exactly the
  runs that need every one. The CI guide says to branch on `fullRun` and run the
  suite unfiltered, and a test pins the shape.
- `--format` with nothing after it is now an error rather than the default.
  `covsel affected --format "$FMT"` with `FMT` unset produced exactly that argv,
  and answering a pipeline that asked for data with prose leaves its parser
  reading an empty answer.
- `affected` reports `files` and `tests` separately: `files` is the adapter's
  runner-native rendering, identical to what `--format files` prints, and `tests`
  the plain test files behind it. They are the same list until selection is
  per-test, and a job sharding the suite needs the second.
- `AffectedResult.discovered` is new: the test files discovery found, whether or
  not they were selected. It is the denominator a selection only means anything
  against — one test chosen out of two and one chosen out of two hundred are the
  same `tests` list and completely different news, and a `testGlobs` that stopped
  matching looks like a very precise selection without it. **Breaking for anything
  that constructs an `AffectedResult`** rather than reading one — a custom
  `select` passed to `watchAffected` is the case in practice — since the property
  is required. Reading one is unaffected.
- `StatusResult.commit` is new, and `covsel status` prints a `commit:` line. The
  commit a map records is the tree selection measures change from, which is the
  fact the whole CI recipe turns on, and it was the one thing the report did not
  say. A map recording none reads `none recorded`, which is why the `next:` line
  below it says full run.
- Absent keys in the JSON mean unknown, never zero. A map covsel could not read
  has no `entryCount`; a key reading `0` would describe an empty map instead of
  an unreadable one.
