---
'@covsel/core': minor
'covsel': minor
---

Let a project supply its own test inventory, for tests whose definitions live
outside this repository's diff.

covsel decides a test changed from a git diff of `testGlobs`, which assumes the
test's definition is a file this repository tracks. That breaks for a
spec-driven project pinning a scenario suite from another repository, a contract
test pulled from a broker, or any suite whose definitions live somewhere a diff
of this repository cannot see -- until now the only safe answer was to make the
pin file a sentinel, forcing a full run on every pin move however small.

- `inventory.command` names a shell command that prints covsel's own inventory
  JSON: every test's id (a virtual `file`, since it need not be a path in this
  repository, plus an optional `name`) and, where its owner tracks one, an
  opaque `version`.
- An id new to the inventory, one whose version differs from the recorded one,
  and one with no version at all all run regardless of the diff -- an id with
  no version is never read as unchanged.
- An id the map recorded that the inventory no longer names is dropped, and
  selects nothing on its own.
- The inventory's `source` -- the identity of whatever defines and executes
  these tests -- is read the way a sentinel is: a change to it runs the whole
  suite, because a different harness can change every test in it without moving
  a single id or version.
- A command that fails, or whose output does not parse as covsel's inventory
  shape, is a full run -- never an empty selection, the same reading an
  unusable map already gets.
- The map records the inventory it was recorded against (schema v6 --
  `MAP_SCHEMA_VERSION` bump, so every map recorded before this is re-recorded
  once). `covsel status` and `covsel explain <path>` report how many of the
  current inventory's ids are new or changed since the recording.

A project that sets no `inventory` is unaffected: added or changed test files
are still detected the ordinary way, from a diff of `testGlobs`.
