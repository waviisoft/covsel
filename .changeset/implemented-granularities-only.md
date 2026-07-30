---
'@covsel/core': minor
'covsel': minor
---

Admit only the granularities covsel records at, and refuse a map or a config
naming another.

`Granularity` was `'file' | 'block' | 'line'`. Nothing wrote `'line'` and
nothing read it: no recorder produced it, `CovselConfig.granularity` never
offered it, and every downstream check spells the question `granularity ===
'block'`. It was a variant of a versioned on-disk contract that could not occur
— the map promising a meaning covsel had no way to supply.

`isUsableMap` did not validate the field either, so a hand-written map claiming
`'line'` was accepted and then degraded to whole-file selection. That is the
safe direction, but by luck rather than by design: one check written `!== 'file'`
instead of `=== 'block'` would have had it selecting by blocks the entries never
carried, which skips tests.

`'line'` is now gone from the type, and it is not coming back under another name.
Blocks are fingerprinted by content precisely so the map survives reformatting
and line shifts; a line-keyed map goes stale on a change that alters no behaviour
at all. The want behind "line" is smaller blocks, and that is an argument about
block extraction, not about line numbers.

`GRANULARITIES` and `isGranularity` are exported, and both ends now check:

- `isUsableMap` rejects a map whose granularity is not one covsel records at, so
  it reads back as no map and selection falls open to a full run. Rejecting
  rather than degrading to whole-file keeps the guarantee independent of how a
  later reader spells its check — an unrecognized granularity is refused before
  anything reads the entries.
- `resolveConfig` throws on an unsupported granularity, naming `file` and
  `block`, instead of resolving it to a value the project never asked for. It
  cannot cost a test: nothing has been selected at the point it fails.

**Migration: no map needs to change, and there is no schema bump.**
`MAP_SCHEMA_VERSION` stays at 2. No map in the wild can contain `'line'`, since
nothing ever wrote it, so bumping would invalidate every stored map — a full
recording run for every user — to reject a value none of them have. Maps
recorded at `file` or `block` keep selecting exactly as they did.

**One config does need editing, and this is the breaking part.** A `covsel.json`
or `covsel.config.js` naming a granularity covsel does not implement used to
resolve through and record at `block` or `file` anyway; every command now fails
under it. Change such a value to `block` (the default, function-level) or `file`.
An explicit `null` still means "unset" and takes the default, as it does for
every other field.

Two maps do become unusable, and both fall open to a full run rather than
selecting anything: one hand-edited to a granularity covsel does not implement,
and one missing the field entirely. Neither is a shape covsel has ever written —
every recording and every merge stamps a granularity — so in practice this is a
guard against hand-edited and foreign maps, not a migration. A project that
recovers by re-recording gets a map identical to the one it had.
