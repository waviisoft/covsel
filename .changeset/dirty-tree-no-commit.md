---
'@covsel/core': patch
'covsel': patch
---

Fix a map recorded from a dirty working tree being stamped with `HEAD`, which
could skip a test.

`assembleMap` stamped every map with `git rev-parse HEAD`, which knows nothing
about uncommitted work — so a map recorded mid-edit described the tree as edited
while claiming to describe `HEAD`. Selection treats a recorded commit as exact, so
once the tree returned to `HEAD` (a revert, a stash, a fresh clone at that commit,
or CI restoring the map onto it) the diff from the stamped commit was empty and the
map was fully trusted for a tree it never described. Coverage the edited tree did
not execute was absent from a map that `covsel status` reported as healthy, and
both guards that normally catch a bad map passed: the commit genuinely existed and
genuinely matched the tree, and the changed file was inside the observed scope.

A map covsel cannot attribute to a commit now records none, and the existing
fall-open path takes over with the reason it already had — _"map records no commit,
so changes since it was recorded are unknown"_. `covsel record` says so when it
writes the map, rather than leaving it to be discovered when selection later
declines to narrow, and `RecordResult` carries `unanchored` for embedders.

The cost is deliberate: recording with uncommitted work now yields full runs until
you commit and re-record. That is what covsel actually knows about such a map. CI
is unaffected, since it records on a clean checkout.
