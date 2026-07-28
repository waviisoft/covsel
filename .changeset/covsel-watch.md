---
'@covsel/core': minor
'covsel': minor
---

Add `covsel watch`, which drives the record/affected/run loop continuously: it
watches the working tree and, on each debounced batch of changes, runs the tests
those changes affect. Change events decide only _when_ to select, never _what_ —
every batch re-runs the same selection against the git diff — so a coalesced
event, a renamed directory, or a platform that reports a change without naming
the file still gets a complete answer. Source changes select through the map,
test-file changes always run that test, and sentinel changes run everything,
because watch calls `selectAffected` rather than restating policy of its own.
Writes to gitignored paths do not trigger a run, since a file git ignores cannot
appear in a diff; when git cannot answer, every path counts.

The loop is built so it cannot quietly stop selecting. Selection that cannot be
computed falls open to a full run with the reason printed, on every batch and not
just the first; a failing or unstartable run leaves the watcher alive; a
reporting callback that throws cannot kill it; and a watcher that dies stops the
loop with a non-zero exit rather than sitting there looking healthy. Runs never
overlap — changes arriving mid-run produce exactly one follow-up run — and the
debounce has a ceiling, so something writing continuously next door cannot
postpone every run indefinitely. Watching uses a single recursive `node:fs`
watcher, with no third-party file-watching dependency.

Re-recording the map after a green run is opt-in via `--record`, and happens only
when the working tree is clean. A map is stamped with the commit it was recorded
on, so one recorded mid-edit would claim to describe code that commit does not
contain — check that commit out again and covsel would trust a map that never
described it. `--record` therefore refreshes at each commit rather than each
save; left alone, a map only ages, which broadens selection rather than narrowing
it.

`@covsel/core` gains `watchAffected`, `runAffectedSelection` (the full-run and
adapter-narrowing split lifted out of `runAffected`, which now calls it),
`filterUnignored`, and `isDirtyWorkTree`.
