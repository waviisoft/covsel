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
commit. When the map records a commit this checkout does not have, or records
none at all, the window since recording cannot be established and selection
falls open to a full run with a clear reason. An explicit `--since` still wins.

`mergeMaps` (and `Store.merge`) combine shard maps from a split CI suite: entries
union by test id, granularity drops to `file` unless every shard recorded blocks,
`recordedAt` is the oldest shard's, and the commit survives only when all shards
agree. The new `covsel merge <maps...> [--out <file>]` command exposes it.
