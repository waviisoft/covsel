# @covsel/conformance

## 0.1.0

### Minor Changes

- c9d768d: Move the adapter capability contract into `@covsel/core`, so an adapter is one
  object satisfying one type.

  **Breaking -- a minor bump only because covsel is pre-1.0, where a minor may
  carry breaking changes: the `Adapter` interface has new required members.** It was `name` + `formatSelection`; it now also requires
  `createRecorder(init)` and offers two optional capabilities, `runSelection(init)`
  for runners that can be narrowed below file level and `defaultTestGlobs` for
  runners whose tests are not `*.test.*` sources. Anything implementing `Adapter`
  directly will not compile until it supplies a recorder factory. `Recorder`,
  `RecordedUnit`, and `RecordedTest` moved from `commands.ts` to `interfaces.ts`
  within core; they are exported from the same place as before.

  **Breaking for `@covsel/conformance`:** `AdapterConformanceSpec` is now
  `{ adapter, fixture }`. Its `createRecorder` and `runSelection` fields are gone —
  the suite asks the adapter object for both, so it exercises the same code path
  the CLI does instead of a hand-assembled equivalent. Fixtures no longer need to
  set `testGlobs` for a runner whose adapter supplies `defaultTestGlobs`.

  Why: an adapter used to be three different things — core's `Adapter`, the CLI's
  private `AdapterEntry`, and the conformance kit's spec — so each adapter package
  shipped two to four loose symbols with no type binding them, and the contract
  deciding what an adapter can do lived in the CLI rather than in core. Adding a
  runner now means writing one object that satisfies one type, and the compiler
  catches an incomplete adapter instead of a reviewer noticing a missing registry
  field.

  Also in core: `runSelected({ adapter, selected, command, cwd })` hands one
  selection to a runner — the adapter's own narrowing when it has one, otherwise
  the command with `formatSelection`'s file list appended — and `runAffected` and
  the conformance kit both go through it, which puts `formatSelection` on the
  product's execution path for the first time. An empty selection runs nothing
  either way, since appending an empty file list would hand the runner its whole
  suite. `resolveConfigFor(adapter, raw)`
  applies an adapter's default test globs in one place for every consumer.
  `selectAffected` now returns `selected` sorted by file and then name, so
  collapsing it to files yields exactly the sorted `tests` list it already
  returned. Selection outcomes are unchanged.

  For adapter packages, each now exports its adapter as a complete object rather
  than as a name and a format function beside unrelated factories. `covsel`
  depends on `@covsel/adapter-generic` and resolves the default adapter from it,
  instead of assembling a generic entry inline from core; its registry is a name →
  object map that defines no adapter-shaped type of its own, and `affected` and
  `run` now report an unknown `--adapter` with the names covsel knows rather than
  silently continuing with defaults.

- 88a7f54: Add `@covsel/conformance`, the shared suite every adapter must pass. It writes a
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

- 6ea5fc1: Hold an adapter to the observability scope it declares.

  The existing checks certify what an adapter records. None of them certify what it
  could not have recorded. Every fixture the kit builds executes inside the process
  tree the recorder controls, so a recorder that sees all of a test's execution and
  one that sees a fraction of it produce identical reports. A recorder that
  collects coverage from a browser and nothing of the server the page talks to is
  precise, deterministic, internally consistent, and blind to a whole region of the
  codebase — and every check passes, because under-recording is if anything _more_
  precise.

  The new check reads the recorded map back against the scope it was recorded with,
  in both directions. Nothing an adapter records may lie outside that scope:
  coverage there is never read, so reporting it means the declaration describes
  something other than what the recorder watches. And anything inside that scope
  the fixture's units execute must appear in the map, because a recorder claiming
  ground it was never watching is what turns a blind spot into "this code ran
  nowhere".

  Exercising the second half needs a fixture that executes code across the
  boundary, so `ConformanceFixture` grows an optional `blindSpot`: a source both
  units execute, plus a `breakingEdit` that makes both of them fail. A recorder
  declaring less than the whole repo must have one outside its scope, since a
  fixture whose units execute nothing out there never exercises the declaration.
  That question is asked of the declaration rather than of the fixture's file list,
  so an asset no unit executes neither demands a blind spot nor stands in for one.
  Nothing lies outside `OBSERVES_EVERYTHING`, so an adapter that observes its whole
  runner needs none — and every adapter shipped here supplies one anyway, which is
  what holds each recorder to having recorded code it claims it could see.

  Two fixture properties are proved rather than trusted, the way the shared source
  must be reached indirectly and a `bodyEdit` must reach a function body. The blind
  spot is proved load-bearing by difference: both units are run whole and required
  to pass, the breaking edit is applied, and the run is required to fail — a
  non-zero exit alone would also be produced by a runner that runs nothing and
  reports failure. And a `blindSpot` naming a test file or a sentinel is rejected
  outright, because a change to either forces a full run whatever the recording
  observed and so could never show that the declared scope was what caused one.

  An adapter that declares a partial scope and reports coverage outside it — safe,
  but inconsistent — newly fails conformance. Report only what the declaration
  covers; widen the declaration only for paths the recorder really would have seen.

- 47044db: A recorder can now record the whole suite in one invocation, returning a unit per
  test, by implementing `recordRun(testFiles)` instead of `record(testFile)`.
  Recording reconciles what comes back against the files it asked for, so a test
  file the run never reported fails the recording rather than being written as
  silence. `Recorder.record` is now optional; a recorder must implement one of the
  two, and recording refuses one offering neither. The conformance kit drives
  either mode.
- 5507f29: Move the istanbul coverage reader into `@covsel/core`, so the Vitest and Jest
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

### Patch Changes

- Updated dependencies [c9d768d]
- Updated dependencies [88a7f54]
- Updated dependencies [dcb274c]
- Updated dependencies [6b05505]
- Updated dependencies [6e1c58d]
- Updated dependencies [b1b7798]
- Updated dependencies [bef646c]
- Updated dependencies [a5cec27]
- Updated dependencies [1281329]
- Updated dependencies [1281329]
- Updated dependencies [8e1cff2]
- Updated dependencies [ded16be]
- Updated dependencies [8f8a6d4]
- Updated dependencies [f068792]
- Updated dependencies [181135e]
- Updated dependencies [7b3e9f3]
- Updated dependencies [7e034a9]
- Updated dependencies [9357ecf]
- Updated dependencies [70f12a5]
- Updated dependencies [b00c7cb]
- Updated dependencies [e406004]
- Updated dependencies [1281329]
- Updated dependencies [89a25dc]
- Updated dependencies [3cc55e7]
- Updated dependencies [859ff72]
- Updated dependencies [dbaf1b5]
- Updated dependencies [9241c52]
- Updated dependencies [94f8d85]
- Updated dependencies [505db55]
- Updated dependencies [a9bbe19]
- Updated dependencies [7886f0b]
- Updated dependencies [049ee96]
- Updated dependencies [8d54ff3]
- Updated dependencies [7a64bfc]
- Updated dependencies [6071216]
- Updated dependencies [47044db]
- Updated dependencies [6e777ed]
- Updated dependencies [6c318cc]
- Updated dependencies [861ce05]
- Updated dependencies [5507f29]
- Updated dependencies [505db55]
- Updated dependencies [6020222]
- Updated dependencies [538db8f]
- Updated dependencies [76df431]
- Updated dependencies [1281329]
  - @covsel/core@0.1.0
