---
'@covsel/core': minor
'@covsel/adapter-vitest': minor
---

Add block-hash granularity. covsel now records which functions each test
executed, fingerprinted by whitespace-normalized content hash (so the map
survives reformatting and line shifts), and selects at that granularity:
editing one function selects only the tests that ran it, even when several tests
import the same file, while a top-level edit or an unparseable change falls back
to selecting every test on the file.

`@covsel/core` gains `extractBlocks`, `selectExecutedBlocks`, `blockHashesOf`,
and `changedBlockHashes`, a real `V8FileMapper.toBlocks`, a block-aware
`FileSelector` driven by `Change.changedBlockHashes`, and a `granularity`
config option (default `block`; set `file` to opt out). The `Recorder` contract
now returns `{ files, blocks }`, and `@covsel/adapter-vitest` records executed
blocks from Vitest's istanbul function map. Recording defaults to block
granularity; a `file`-granularity map still selects exactly as before.
