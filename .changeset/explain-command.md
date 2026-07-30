---
'@covsel/core': minor
'covsel': minor
---

Add `covsel explain <path>`, the map read in the other direction: given a source
file, the tests whose recordings credit it and — at block granularity — which of
its functions they ran; given a test file, the sources each recorded unit
covered.

The map is stored as test → covered code, so answering "what covers this file,
and why didn't my test run?" meant reading `.covsel/map.json` by hand, at exactly
the moment someone already distrusts selection. `explain` builds the reverse
index, and answers the silences too: a test the map does not record always runs,
a path outside what the recording could observe falls open to a full run, and a
source no test covers selects nothing unless a sentinel or `alwaysRun` glob
matches — each of which is a different reason for the same empty list.

A path that is both a test and something another test covers is explained as
both, since either half alone misstates what a change to it selects. Blocks are
named by re-parsing the file as it stands now, which also makes drift visible: a
recorded block hash the file no longer contains is a block that changed since
the recording. Long lists are summarized with a count; `--all` prints them in
full.

Read-only — it changes no selection, no policy, and no schema. `@covsel/core`
gains `explainPath` alongside `computeStatus`.
