---
'@covsel/adapter-node-test': patch
'@covsel/adapter-jest': patch
'@covsel/adapter-cucumber': patch
'@covsel/adapter-vitest': patch
'@covsel/core': minor
'covsel': patch
---

Record what a recording could observe, and fall open on changes outside it.

A map says which files each test covered. It could not say whether "not covered"
means "did not run" or "ran somewhere the recorder was not looking" — and
selection read it the first way. That is safe for every adapter shipped so far,
because each observes the code under test in the process tree it controls, so
absence really is a measurement. It stops being safe the moment a recorder sees
only part of a test's execution: a browser but not the server behind it, one
isolate of several. Such a recorder produces a map that is non-empty,
internally consistent, deterministic, and quietly missing whole regions of the
codebase, and selecting on it skips tests the change breaks.

`Recorder` now carries `observes`, the repo-relative globs it is able to see
execution within, and `CoverageMap` carries the `observed` scope it was recorded
with. A change to a path outside that scope forces a full run, naming the path.
Recorders that would see any path that ran declare `OBSERVES_EVERYTHING`, which
is what the generic, Vitest, Jest, node:test, and cucumber recorders do, so
selection
is unchanged for every adapter that exists today.

The declaration is required rather than defaulted. A map that does not state its
scope is not usable, because the only available guess — "it observed everything"
— is exactly the guess that loses tests. `MAP_SCHEMA_VERSION` moves to 2, so
maps recorded before this change fall open to a full run rather than being read
under the new rule.

The scope is matched strictly, unlike every other glob set in covsel. The shared
matcher widens slash-less globs to match a basename anywhere, which is right for
sentinels, test globs, and always-run globs, where a wider match runs more tests.
The polarity inverts here: a path wrongly counted as observed suppresses the full
run it should have caused, so `makeStrictMatcher` reads these globs as written.

`mergeMaps` keeps the scope only when every shard agrees on it, and otherwise
produces a map claiming nothing, which falls open on any change. Unioning would
let one shard's coverage vouch for paths another shard was never watching. The
CLI says so on merge, and `covsel status` reports the observed scope alongside
granularity.
