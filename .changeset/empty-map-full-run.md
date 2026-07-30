---
'@covsel/core': patch
'covsel': patch
---

Fix an empty map selecting no tests and exiting 0.

Three separate holes, all reachable from one mundane cause — `testGlobs` that do
not match the project's layout. The default globs look for `*.test.js`, and
express, like many Mocha and node:test projects, names its tests `test/*.js`.

`covsel record` treated "no test files discovered" as success: it wrote a
syntactically valid map with `"entries": []` and exited 0. Recording now fails,
writes no map, and names both the globs it tried and the directory it searched.
There is no repository for which an empty map is the right answer.

`FailOpenPolicy` now forces a full run for a map with no entries, and
`fullRunReason` says why. Such a map measured nothing, so its silence about a
changed file is not a measurement — reading it as "no test covers this" is what
turned a mismatched glob into a green CI job that ran no tests.

Selecting when discovery finds no test files falls open to a full run instead of
returning an empty selection. A full run hands the runner its own command
unfiltered, so the runner's own discovery finds the tests covsel's globs missed —
where before, `covsel run` executed zero tests and exited 0.

`covsel status` reports the discovered test count, and reports an entry-less map or
a project with no discovered tests as a full run with the reason, rather than as
`next: select`. `StatusResult` gains `discoveredTestCount`, and `RecordResult`
gains `error` for a failure that belongs to the run rather than to a test file.

Note for anyone with fixtures: a `CoverageMap` with `entries: []` is now always a
full run, so a test using one as a stand-in for "some map" needs an entry to
exercise anything downstream of that check.
