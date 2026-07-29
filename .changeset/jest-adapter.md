---
'@covsel/adapter-jest': minor
'covsel': minor
---

Add `@covsel/adapter-jest`, so `covsel record|affected|run --adapter jest` works
end to end on a Jest suite. Jest compiles sources through its own transformer and
evaluates them from its module registry, so a raw `NODE_V8_COVERAGE` dump names
the original files but addresses the transformed code — offsets land past the end
of the file they claim to describe, and blocks hashed from them are meaningless.
The adapter therefore records with Jest's own coverage, which remaps execution
back to sources through the transformer's source maps, and reads the istanbul
`coverage-final.json`. Coverage is built into Jest, so no extra dependency is
needed in the target project. Selection is whole-file, and recording pins each
run to one test file with `--runTestsByPath` so a path cannot pull in files it
merely resembles.

The CLI's adapter dispatch now comes from a single registry rather than a chain
of name comparisons at each call site.
