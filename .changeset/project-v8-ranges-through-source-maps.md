---
'@covsel/core': minor
---

Add `projectRanges`, which turns a script's V8 coverage ranges plus its source
map into executed regions in the original sources' own offsets, ready for
`selectExecutedBlocks`. Every range is projected, anonymous functions included,
and ranges that reach no original source are reported as unprojected rather than
attributed to one. Also exports `decodeMappings` and `indexedSources`.
