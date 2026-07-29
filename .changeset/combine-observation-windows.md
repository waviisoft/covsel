---
'@covsel/core': minor
---

Combine several observation windows into one recorded unit.

A recorded unit has carried one set of files and blocks from one observation,
which is the whole story for every adapter shipped so far: the code under test
runs in the process tree the recorder controls. A runner that drives a browser
breaks that. One test spans at least two V8 isolates — the browser rendering the
app and the worker running the spec — and usually a third, an application server.
Each is observed by its own mechanism, and an entry built from any one of them is
non-empty, internally consistent, deterministic, and quietly missing whole
regions of the codebase.

`combineObservations(test, windows)` folds them into a single unit. Covered files
union by path and blocks deduplicate by file and hash. Blocks drop for any file a
contributing window recorded _without_ them: that window knows nothing about
which of the file's blocks ran, and keeping another window's would let a change
to a block only its isolate executed miss the entry. A window that recorded
nothing at all observed nothing execute, which is a measurement rather than
missing block data, and costs the entry nothing.

Scopes union, so the unit claims what its windows together could see and never
more — `src/**` and `server/**`, never `**`. That is the opposite of the shard
rule, where disagreeing maps claim nothing, and it follows the same invariant: no
entry may be vouched for by a scope that was not watching that entry's execution.
Shards observe different entries; windows observe the same execution, and the
combined entry carries all of them. `unionScopes` and `agreedScope` are the two
reductions, and `mergeMaps` now uses the latter.

A window that produced nothing usable fails the whole unit, as does combining no
windows at all. Half a test's execution recorded as all of it is exactly the map
that skips tests, so recording fails and no map is written rather than keeping
the half that worked.

`recordMap` stamps the map with what the units reported, falling back to the
recorder's declaration when they report none. Units observed through different
window sets reduce the map's scope to claiming nothing, which falls open. What
units report can only narrow: a unit claiming a glob its recorder does not
declare fails the recording, because resolving that contradiction the other way
would turn a recorder's own admission that it is blind somewhere into a map
asserting it was watching — and every change there would then be read as a
measurement rather than falling open. Every recorder that exists today has one
window and reports no per-unit scope, so nothing about their maps changes.
