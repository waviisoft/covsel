---
'@covsel/core': minor
---

`V8FileMapper.toBlocks` now projects a source-mapped script's coverage onto the
sources behind it, so a bundle contributes blocks instead of nothing. Previously
only a script whose bytes were the bytes on disk produced blocks, and anything a
bundler fused fell back to whole-file selection. `SourceMapResolver` gains
`resolveProjectable`, which returns the map and the script text alongside the
resolved sources for immediate use, and `ScriptCoverage` gains an optional
`source` for observations that carry the script's text, as browser coverage does.
