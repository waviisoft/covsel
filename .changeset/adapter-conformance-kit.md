---
'@covsel/conformance': minor
---

Add `@covsel/conformance`, the shared suite every adapter must pass. It writes a
throwaway project from an adapter-supplied fixture, records it, edits it, runs
the resulting selection, and checks the behaviour that decides whether selection
can be trusted: that `formatSelection` deduplicates, that recording produces a
usable map, that each test is credited with every source it executed and nothing
else, that recording twice gives the same answer, that editing one source selects
only the unit that executed it, that editing a source both units share selects
both, that handing the selection to the runner really runs the units it names and
no others, and that a new test, a sentinel change, and an unusable map each run
everything.

The recall checks are the point. An adapter that under-records — crediting a test
with the sources it imports directly but not the ones reached through them — is
precise, deterministic, and passes every fail-open check, because core's policy
covers new tests and sentinels but cannot know about coverage the adapter never
reported. It then silently skips tests. So a fixture declares a `sharedSource`
both units execute, and each unit appends its label to `RAN_MARKER_FILE` when it
runs, which is how the suite sees what a selection actually executed without
parsing any runner's output.

Adapters using Vitest register the suite with `describeAdapterConformance`, which
reports each check as its own test; anything else calls `runAdapterConformance`
and asserts on the returned report. Fixtures are adapter-specific — two units
executing different sources plus one they share, optionally identified by test
name when they live in the same file, and a `runSelection` for runners that can
narrow a run below file level — while the assertions are shared, so a community
adapter proves itself against the same bar as the built-in ones. The kit's own
tests break an adapter on purpose to confirm the checks still fail when they
should, including one that is wrong in the only way that skips tests.
