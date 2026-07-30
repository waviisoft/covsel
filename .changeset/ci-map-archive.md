---
'@covsel/core': minor
'covsel': minor
---

Add the CI map lifecycle: `covsel publish` archives a recorded map under the
commit it records, and `covsel fetch` installs the archived map this checkout is
actually able to measure change from.

Restoring the _newest_ map is the obvious approach and the wrong one. The newest
map was recorded on whatever commit was current when it was written, which may be
a commit the fetching checkout has never heard of — another branch, a force-push,
a pruned history. Selection then falls open to a full run, which is safe and
costs exactly the minutes covsel exists to save, while an older map recorded on an
ancestor of `HEAD` would have selected. So an archive keeps several maps and
`fetch` chooses: the most recently recorded map whose commit is an ancestor of
`HEAD` first; failing that the newest commit the checkout has, which still
selects soundly because a map's commit is diffed tree-against-tree rather than
through a merge-base, but spans two diverged trees and so over-selects; failing
that nothing, and the next run is a full one. Every candidate passed over is
reported with the reason, and a fetch that finds nothing exits 0 — a CI job that
would rather know asks with `--require`.

`publish` refuses a map that records no commit, because nothing could measure
change from it and every job that fetched it would fall open — the failure belongs
to the run that recorded it, not to every pull request afterwards. It also
refuses a commit that is not a hash, so a hand-edited map cannot decide where
covsel writes. Publishing the same commit twice replaces it, and the archive
keeps its 20 newest maps (`--keep <n>`).

`fetch` will not replace a local map recorded more recently than the archived one
without `--force`, so it cannot quietly undo a developer's own recording; CI
never meets that case, since a fresh checkout has no local map.

An archived map is named for the instant it was recorded and the commit it records,
so listing an archive opens nothing — a map is not small, and parsing every
candidate to recover two fields would mean reading hundreds of megabytes before a
job's first test. It also means every archived file is a pruning candidate whatever
its contents, which matters after a schema bump: judged by usability, the maps an
upgrade invalidated would be invisible to `--keep` and would sit in the archive, and
in every cache entry copied from it, forever. Whether a chosen map is usable is
settled when it is opened, and an unusable one is passed over for the next
candidate rather than failing the fetch.

`@covsel/core` gains `publishMap`, `fetchMap`, `listArchive`, `readArchivedMap`,
`chooseArchivedMap`, `gitCommitChecks`, `archiveDirFor`, `isAncestorCommit`, and
`CovselConfig.store.archiveDir` (default `archive`, read relative to the store
directory so caching the store carries the archive with it).

covsel now uses this on itself: a `covsel map` workflow records and publishes on
`main`, and a `select` job on every pull request fetches the map and runs the
affected tests — alongside the job that runs the whole suite, never instead of it.
