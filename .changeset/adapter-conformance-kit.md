---
'@covsel/conformance': minor
'@covsel/core': patch
---

Add `@covsel/conformance`, the shared suite every adapter must pass. It writes a
throwaway project from an adapter-supplied fixture, records it, edits it, runs
the resulting selection, and checks the behaviour that decides whether selection
can be trusted: that `formatSelection` deduplicates, that recording produces a
usable map, that each unit is credited with the sources it executed and no
others, that recording twice gives the same answer, that editing one source
selects only the unit that executed it, that editing a source both units reach
selects both, that changing a function body selects the unit that ran it, that
handing the selection to the runner really runs the units it names and no others,
and that a new test, a sentinel change, and an unusable map each run everything.

Three of those checks exist because an adapter can be wrong in ways nothing else
notices. covsel's fail-open policy covers new tests, sentinels, and unusable
maps, but it can only act on coverage the adapter reported — so an adapter that
under-records is precise, deterministic, passes every fail-open check, and
silently skips tests. Each check pins one such shape:

- **Recording only what a test file names.** The fixture's `sharedSource` must be
  reached _through_ each unit's own source, never imported by a test file; the
  suite rejects a fixture whose test files mention it, so the indirection cannot
  be satisfied on paper.
- **Recording only module skeletons.** Appending to a file perturbs only the
  module block, so each unit declares a `bodyEdit` — a change inside a function
  body — and the suite rejects one that changes the module block or leaves every
  function hash intact. Without it the block-granularity path, which is the
  default, is never exercised.
- **Building an invocation that runs nothing and exits 0.** Each unit appends its
  label to `RAN_MARKER_FILE` when it runs, which lets the suite see what a
  selection actually executed without parsing any runner's output format.

Adapters using Vitest register the suite with `describeAdapterConformance`, which
reports each check as its own test; anything else calls `runAdapterConformance`
and asserts on the returned report. Fixtures are adapter-specific — two units
executing different sources plus one they reach indirectly, optionally identified
by test name when they live in the same file, and a `runSelection` for runners
that can narrow a run below file level — while the assertions are shared, so a
community adapter proves itself against the same bar as the built-in ones.

The kit's own tests break an adapter on purpose to confirm the checks still fail
when they should. They are deliberately _structural_ — depth-limited,
block-truncating, selection-ignoring — because an adapter broken by deleting the
exact path a check names proves only that the check reads its own argument.

`@covsel/core` now exports `MODULE_BLOCK`, the name of the top-level skeleton
block, so callers can tell a module-level change from a function-level one
without hardcoding the string.
