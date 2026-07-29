---
'@covsel/core': minor
'@covsel/adapter-jest': patch
'@covsel/adapter-vitest': patch
---

Move the istanbul coverage reader into `@covsel/core`, so the Vitest and Jest
adapters share one copy.

Both adapters record by reading their runner's own `coverage-final.json`, and both
carried an identical copy of the code that reads it: the entry shape, the
executed-counter predicate, the function-map-to-blocks conversion, and the loop
that filters a report to repo sources and hashes each file. They were duplicated
because adapters may not depend on each other, which is the right constraint, and
nothing shared existed to hold it.

Two copies of a parser is a nuisance. Two copies of _this_ parser is a hazard: it
decides which sources a test is credited with, so a fix applied to one and not the
other leaves one runner under-recording, which is the fail-closed direction — a
test that needed to run, skipped.

`@covsel/core` now exports `readIstanbulReport`, `istanbulCoverage`,
`istanbulExecuted`, `istanbulBlocks`, and the `CoverageFinalEntry` /
`IstanbulReport` / `IstanbulPosition` types. Reading the file and interpreting it
are separate on purpose: what a _missing_ report means is runner-specific — a
coverage provider Vitest does not bundle, versus a Jest config overriding its
reporters — so each adapter keeps its own diagnostic while core owns the parsing.
Block extraction reads the configured granularity itself rather than at each call
site.

Nothing about what either adapter records changes. Both adapters' conformance
suites and both golden end-to-end examples pass unchanged, which is what would
catch a reader that silently altered what it credits.
