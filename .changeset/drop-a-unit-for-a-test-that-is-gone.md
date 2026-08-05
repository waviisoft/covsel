---
'@covsel/core': patch
'covsel': patch
---

Never name a test file the checkout does not have.

A map entry outlives the test file it names. Delete a test, change a source it
covered, and the entry is still there crediting that source — so the selection
named a path that is no longer in the suite.

Nothing was skipped by it, which is why it went unnoticed. What it did was hand
the decision to the runner, and the runners disagree: vitest ignores a path it
cannot find and quietly runs one fewer file than the selection named, while a
runner that treats an unknown path as an error turns the whole run red over a
stale entry. Neither is an answer worth leaving to chance, and the first is the
worse of the two — a selection reporting six files and running five.

Units are now dropped when discovery does not find their test file, which is the
rule already applied to entries crediting no source at all. Drawn from discovery
rather than from the diff, because a file can leave the suite without any diff
saying so: renamed, moved out of `testGlobs`, or excluded by a config change.

`status` gained `staleEntryCount`, the number of entries naming a test the suite
no longer has, printed only when there are any. Selection drops them silently and
correctly, which is exactly why it is worth reporting: nothing else in that report
would say the map has drifted from the _suite_ rather than from the sources, and
a map still describing tests the project removed is a map due to be recorded
again.
