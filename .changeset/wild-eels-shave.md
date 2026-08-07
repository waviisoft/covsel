---
'@covsel/adapter-vitest': minor
'@covsel/conformance': minor
'@covsel/core': minor
'covsel': minor
---

Add `covsel doctor`, which compares the test files covsel discovers against the
files your runner itself collects and exits non-zero when the two disagree.

Your runner's `include`/`testMatch` and covsel's `testGlobs` are two lists that
have to say the same thing, and nothing kept them in step. The two ways they can
drift fail very differently. A file the runner collects and covsel does not
discover is recorded by nothing and selected by nothing: it runs today because
your full-run job runs it, and it stops running the day selection decides what
runs — on a green job, with no line anywhere saying the suite got smaller. A file
covsel discovers and the runner does not collect is the reverse, and is what
leaves a project with no map at all.

`covsel doctor -- <command>` reports both directions separately, naming the field
that repairs each: `testGlobs` to discover more, `testIgnore` to subtract a file
your runner deliberately excludes.

Asking the runner is a new optional adapter capability, `listTests`. The Vitest
adapter implements it; a runner with no listing mode omits it, and `covsel doctor`
then says the check did not run rather than reporting that nothing is wrong.
`--require` turns that into a non-zero exit. The answer is only ever compared
against covsel's own discovery, never used in place of it: a listing covsel
cannot verify would be a new way for the suite to shrink silently.
