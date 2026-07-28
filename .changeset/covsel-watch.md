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
just the first; a failing or unstartable run leaves the watcher alive; and a
watcher that dies stops the loop with a non-zero exit rather than sitting there
looking healthy. Runs never overlap — changes arriving mid-run produce exactly
one follow-up run. Re-recording the map after a green run is opt-in via
`--record`: it costs a full suite run, and a map that only ages over-selects, so
drift costs precision rather than correctness. Watching uses a single recursive
`node:fs` watcher, with no third-party file-watching dependency.

`@covsel/core` gains `watchAffected` and `runSelectionCommand`, and `covsel run`
now rejects an unknown `--adapter` instead of silently falling back to the
default.
