---
'@covsel/core': minor
'@covsel/conformance': minor
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

An adapter now says so: `Adapter.coverageReport` declares the shape of report the
runner produces when covsel is what reads it, currently `'istanbul'`. It is a
claim with consequences rather than a label — declaring it means core's reader
decides which files are credited and whether blocks are extracted, from the same
config everything else reads. `assertAdapter` rejects a shape covsel has no reader
for, since deferring to a reader that does not exist leaves nobody interpreting
the report.

The conformance suite holds a declaring adapter to that, and does it without
knowing any adapter's name: asked to record at file granularity, an adapter using
covsel's reader emits no blocks, while one that kept a private reading of the
report has to have remembered to. That is precisely the setting a second copy of
the reader forgets, and the drift stays invisible until a map narrows by blocks it
should not have. Adapters that obtain coverage some other way — raw V8, the
inspector — declare nothing and the check reports itself as not applicable.

What either adapter records is unchanged, and both adapters' conformance suites
and both golden end-to-end examples pass unchanged — which is what would catch a
reader that silently altered what it credits.

Two edge cases do resolve differently, both toward failing loudly rather than
crediting nothing. A `coverage-final.json` that parses to something other than an
object — an array, a bare string — is now treated as no report at all, where before
it was iterated to nothing and produced an entry crediting no sources; that is the
shape covsel exists to distrust. And a covered source that cannot be read now
fails the recording consistently: hashing it always threw, while block extraction
silently returned none, so the two halves of one decision disagreed.
