---
'@covsel/conformance': minor
---

Add `@covsel/conformance`, the shared suite every adapter must pass. It writes a
throwaway project from an adapter-supplied fixture, records it, edits it, and
checks the behaviour that decides whether selection can be trusted: that
`formatSelection` deduplicates, that recording produces a usable map, that each
test is credited with the code it ran and nothing else, that recording twice
gives the same answer, that editing one source selects only the unit that
executed it, and that a new test, a sentinel change, and an unusable map each
run everything.

Adapters using Vitest register the suite with `describeAdapterConformance`, which
reports each check as its own test; anything else calls `runAdapterConformance`
and asserts on the returned report. Fixtures are adapter-specific — two units
executing different sources, optionally identified by test name when they share a
file — while the assertions are shared, so a community adapter proves itself
against the same bar as the built-in ones. The kit's own tests break an adapter on
purpose to confirm the checks still fail when they should.
