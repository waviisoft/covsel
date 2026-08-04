---
'@covsel/core': minor
'covsel': minor
---

Always run a test whose entry credits no source.

An entry with an empty file list read to the selector exactly like a test that
covers nothing: no changed path could match it, so nothing ever selected it.
covsel already refuses to read "the map says nothing about this test" as "this
test covers nothing" — a discovered test with no entry always runs — and an
entry crediting nothing is the same claim in a different shape. It was read the
other way, and the test silently never ran again.

The situation is not exotic. A test that drives its subject in a child process,
a worker, or a browser records nothing at all under a recorder whose coverage
mechanism does not reach there. That blind spot belongs to the test rather than
to the recorder, so `observed` — one scope for the whole run — cannot express it
and the empty entry falls straight through. Three of covsel's own test files are
in exactly that position under the Vitest adapter.

So selection now treats an entry crediting no source as unknown coverage: its
test file is selected on every run, whole, including when other units of the
same file did record coverage. A recorder that could not see one unit of a file
has not earned trust in what it recorded for the units beside it, and a test
that genuinely covers nothing running when it need not is the cheap way to be
wrong.

`covsel merge` carries the same doubt across a shard merge. A test one shard
credits with no source keeps crediting nothing rather than inheriting what
another shard saw: an empty entry is a shard reporting it could not see where
the test ran, and unioning it away produced a merged entry claiming something
neither shard claimed. Covered blocks and package lists already degraded to
unknown this way when either shard lacked them; covered files now do too.

Recording is not refused over it — a test that only asserts on constants
legitimately covers nothing — but it is no longer silent. `covsel record` names
each test file that recorded no source as it records it and again in its
summary, `covsel status` counts the entries separately from `entries:`, and
`covsel explain <test>` says the file is selected on every run, distinguishing
it from a test the map does not record at all.
