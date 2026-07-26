---
'@covsel/core': minor
'covsel': minor
---

Anchor selection to the commit the map was recorded on, and add shard merging
for CI.

Selection previously measured change from the merge-base with the default
branch, which silently ignored anything committed since the map was recorded —
so a map published on `main` and restored onto a later commit could skip tests
whose code had changed in between. The diff base is now the map's recorded
commit, compared exactly: its tree against what is on disk, rather than routed
through a merge-base. That distinction matters, because a merge-base hides every
file the recorded commit carries that the current history does not — checking
out an older commit, resetting history back, or restoring a map published on a
branch tip onto a pull request that branched earlier. When the map records a
commit this checkout does not have, or records none at all, the window since
recording cannot be established and selection falls open to a full run with a
clear reason. An explicit `--since` still wins and keeps merge-base semantics.

A discovered test file the map has no entry for now runs. Unknown coverage is
not the same as covering nothing, and this closes the gap left by a recorder
that yielded no units for a file, or by a merged map missing a shard.

`mergeMaps` (and `Store.merge`) combine shard maps from a split CI suite: entries
union by test id, granularity drops to `file` unless every shard recorded blocks,
blocks for a test are dropped entirely when any shard recorded none for it,
`recordedAt` is the oldest shard's, and the commit survives only when all shards
agree. The new `covsel merge <maps...> [--out <file>]` command exposes it.
