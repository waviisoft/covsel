# @covsel/core

## 0.2.0

### Minor Changes

- 2c18c09: Credit a module a test imported but never called into, without re-selecting on
  every signature change.

  `istanbulCoverage` dropped any file whose report entry showed no statement,
  function, or branch hit. A module of nothing but declarations — imports,
  `interface`, `type`, `function` — executes nothing when it loads, so every
  counter is zero and it was dropped. The test imported it, the module ran to
  completion at load, and the map recorded no relationship at all.

  That is the fail-closed direction, and it was reachable. A module gaining a
  top-level side effect — registering something, patching a prototype, installing
  a polyfill — changes what every importer does while selecting none of them. The
  sharpest form is a module that starts throwing on import: the suite is broken and
  `covsel affected` reports nothing to run.

  The generic `NODE_V8_COVERAGE` recorder never behaved this way, since V8 reports
  the script wrapper with a count. The two paths disagreeing about the same fixture
  is what surfaced it.

  **Parity alone would have cost most of the precision**, which is why this is more
  than deleting a line. Crediting a loaded file with the module block means
  crediting the whole top level with function bodies blanked — and that moves
  whenever a signature is added, renamed, or re-typed, which is the common edit. On
  this repository, a pull request that added functions to `commands.ts` selected 30
  of 47 test files; under module-block crediting, every test importing the core
  barrel would have been selected too, for a change that could not have altered any
  of them.

  So a file a test only imported is credited with a new `<load>` block instead: a
  fingerprint over what loading actually does — the module specifiers it pulls in,
  and its top-level executable statements. Not the bindings taken from each
  specifier, which are resolved before anything runs; not function declarations,
  interfaces, or type aliases, which do nothing until something invokes them.

  The property that follows is the one that matters: **a module with no load-time
  behaviour has an empty fingerprint, and an empty fingerprint never changes.** Its
  importers stay unselected until someone gives it top-level behaviour, at which
  point it changes exactly once and selects them. Adding, renaming, or re-signing
  functions does not touch it. A re-export counts, because `export * from './x'`
  loads that module just as an import does.

  A file the test genuinely called into still gets the module block, because it
  executes code there and a signature change can reach it.

  This applies to both recording paths, since both funnel through
  `selectExecutedBlocks` — so the generic recorder also stops over-selecting on
  signature changes to modules its tests only imported.

  `extractBlocks` now emits a `<load>` block for every file, after `<module>`, so
  `blockHashesOf` and the change detection built on it pick it up with no schema
  change.

- 07f570a: Read `sourceGlobs` as the paths they name, not as basenames anywhere in the tree.

  `makeMatcher` gives a slash-less glob a second chance against a path's basename
  at any depth, so that a sentinel like `package.json` also catches a workspace's
  own manifest. That reasoning holds for `sentinels`, where matching more runs more
  tests. It did not hold for `sourceGlobs`, which shared the same matcher.

  A project writing `sourceGlobs: ["index.js"]` to mean _the package entry point_
  silently got every `index.js` in the repository — examples, fixtures, scripts —
  recorded as covered source. Measured on `expressjs/express` with
  `sourceGlobs: ["lib/**/*.js", "index.js"]`: a map reporting **29 covered sources
  for a library that has 7**, the other 22 being example apps that ship to nobody.

  No test was ever skipped by it — the effect is over-selection, which is the safe
  direction. What it cost was the map as a diagnostic and part of the saving:
  `covsel status` reporting 29 sources with no way to see where they came from, and
  editing an example app selecting tests that cannot depend on it.

  `sourceGlobs` are now matched literally, repo-relative. Write `"**/index.js"` for
  the recursive reading — it already worked and says what it means.

  `testGlobs` keeps the widening, and the asymmetry is the point: a source glob
  matching too much costs precision, while a test glob matching too little leaves
  the tests it missed unrun. `"*.test.js"` meaning "only at the root" would be a
  skipped test rather than a wide map.

  **This changes what an existing config means** for any project whose
  `sourceGlobs` contain a slash-less pattern that was matching nested files. Their
  next recording will credit fewer sources; a map recorded before the upgrade keeps
  describing what it described, since the config value itself has not moved.

  `covsel status` also gained a breakdown of covered sources by top-level
  directory, biggest first, printed when they span more than one. The source count
  is the number people read to judge whether their globs say what they meant, and
  on its own it cannot answer that — the express map read `29` with nothing to say
  where the other 22 came from. It is the second half of the same problem: a
  project whose sources come from somewhere it did not intend can now see so at a
  glance, whatever put them there. Also in `status --format json`, as
  `coveredSourcesByDir`.

- 3edd43b: Let a project name the tests its runner will not run, with `testIgnore`.

  covsel finds test files by walking the tree with `testGlobs`. The runner it wraps
  finds them by reading its own configuration. When the runner excludes something
  -- a browser suite kept out of the default config and run by a second one -- the
  two disagree, and covsel tries to record a test the runner refuses to run.

  That is worse than it sounds, because a recording that fails writes **no map at
  all**: a partial map cannot be trusted, so one unrunnable file stops the project
  selecting anything, and every pull request falls open to a full run until someone
  works out why. It is the failure covsel's own `covsel map` workflow hit the day
  its Playwright conformance suite arrived.

  - `testIgnore` is a glob list of test files to leave alone. They are never
    discovered, never recorded, and never selected. It subtracts from `testGlobs`
    rather than narrowing them, because "every test except this one" is not
    something a glob set can say.
  - It applies to discovery alone. A file named here is still a test file
    everywhere that asks what a path _is_, so it cannot be credited as a source of
    its own coverage.
  - It wins over `alwaysRun`. The two claims conflict and only one can hold: a file
    the runner will not run cannot be run whatever else the config asks for.
  - `covsel status` reports how many files it removed, in both the report and
    `--format json` (`ignoredTestCount`), because an exclusion that grows silently
    is a suite shrinking without anyone deciding to. It is a claim that skips tests
    when it is wrong, so it says itself back to you.
  - It is part of the recorded configuration, so changing it forces a full run
    rather than quietly selecting against a map recorded over a different set of
    tests. The first run after upgrading is a full one for the same reason.

  A project that names nothing discovers exactly what it did before.

### Patch Changes

- 8f3646b: Say what a full-run reason measured the change against.

  `sentinel changed: covsel.config.js` is about two states, and it named one. The
  reader has to supply the other, and the obvious guess — _changed in my branch_ —
  is wrong exactly when the message matters most. The window is the commit the map
  records against the working tree, so on a pull request it includes everything
  merged to the default branch since the recording. A branch that never touched
  `covsel.config.js` gets told `covsel.config.js` changed, and the author's first
  move is to search a diff that does not contain it.

  The three reasons that name a changed file now end with the window they were
  measured over:

  ```diff
  -sentinel changed: pnpm-lock.yaml
  +sentinel changed: pnpm-lock.yaml (measured since the map was recorded at a1b2c3d4e5f6)
  ```

  With an explicit `--since`, no recording happened at that ref, so the sentence
  changes to match: `(measured since origin/main)`.

  The qualifier is appended rather than woven into the phrase. Weaving it splits
  what a reader and a `grep` both key on — `sentinel changed: pnpm-lock.yaml`
  becoming `sentinel changed since …: pnpm-lock.yaml` — which moves the answer to
  make room for the note about how the question was asked. Trailing, the answer
  stays where it has always been.

  The reasons that describe the map itself (`no usable map recorded`, an
  incompatible schema, a map with no entries) are unchanged, since none of them is
  about a file having moved. Neither is the config-field comparison, which already
  names its own two states.

  `covsel status` and `covsel explain` now separate that reason with `--` instead
  of wrapping it in parentheses, which is the separator `covsel affected` has
  always used:

  ```diff
  -next:       full run (sentinel changed: package.json)
  +next:       full run -- sentinel changed: package.json (measured since the map was recorded at a1b2c3d4e5f6)
  ```

  Brackets around a reason that now ends in brackets of its own read as
  `full run (sentinel changed: package.json (measured since …))`. The three
  commands that report the same verdict say it the same way instead.

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

- dcb274c: Add block-hash granularity. covsel now records which functions each test
  executed, fingerprinted by whitespace-normalized content hash (so the map
  survives reformatting and line shifts), and selects at that granularity:
  editing one function selects only the tests that ran it, even when several tests
  import the same file, while a top-level edit or an unparseable change falls back
  to selecting every test on the file.

  `@covsel/core` gains `extractBlocks`, `selectExecutedBlocks`, `blockHashesOf`,
  and `changedBlockHashes`, a real `V8FileMapper.toBlocks`, a block-aware
  `FileSelector` driven by `Change.changedBlockHashes`, and a `granularity`
  config option (default `block`; set `file` to opt out). The `Recorder` contract
  now returns `{ files, blocks }`, and `@covsel/adapter-vitest` records executed
  blocks from Vitest's istanbul function map. Recording defaults to block
  granularity; a `file`-granularity map still selects exactly as before.

- 6b05505: Make every lockfile covsel recognises a default sentinel: `bun.lock`,
  `bun.lockb`, and `npm-shrinkwrap.json` join `pnpm-lock.yaml`, `yarn.lock`, and
  `package-lock.json`, so a dependency change in a bun project forces a full run
  like it always did in a pnpm one.

  A dependency change is the one change covsel cannot see any other way. Vendored
  code under `node_modules` is deliberately outside what a recording maps, so
  nothing in the map moves when a dependency version does, and the lockfile is the
  only place the change shows up at all. A lockfile that is not a sentinel is a
  `bun update`, or a lockfile-maintenance pull request, selecting against a map
  recorded before the bump — and skipping the test the new version breaks. A
  project that also edited `package.json` in the same commit was saved by that
  sentinel; the exposure was a lockfile-only diff, which is the ordinary shape of
  re-resolving a floating range.

  The names came in threes rather than ones: bun writes the binary `bun.lockb` in
  older versions and the text `bun.lock` in newer ones, so covering only the name
  you have heard of leaves the other half of bun projects exposed, and npm honours
  `npm-shrinkwrap.json` over `package-lock.json` when a project publishes one.

  `@covsel/core` gains `LOCKFILES` and `LOCKFILE_NAMES`, the single list the
  sentinel defaults and `covsel init`'s package-manager detection now both read.
  Those two had drifted, which is how this happened: `bun.lockb` was already good
  enough to pick an install command with, but not good enough to invalidate a map.
  Detection gains the names it was missing along the way, so a bun project holding
  only the text lockfile no longer reads as npm. It answers as it always did for
  every tree it already recognised, including one carrying two managers'
  lockfiles: `npm-shrinkwrap.json` is checked last, after bun, because a tree
  holding only a shrinkwrap resolves to npm by the fallback regardless, and
  checking it earlier would have moved a bun project that once published one to
  npm for nothing.

  Setting `sentinels` still replaces the defaults wholesale, so a project that has
  narrowed the list keeps whatever lockfile it wants covered.

- 6e1c58d: Add the CI map lifecycle: `covsel publish` archives a recorded map under the
  commit it records, and `covsel fetch` installs the archived map this checkout is
  actually able to measure change from.

  Restoring the _newest_ map is the obvious approach and the wrong one. The newest
  map was recorded on whatever commit was current when it was written, which may be
  a commit the fetching checkout has never heard of — another branch, a force-push,
  a pruned history. Selection then falls open to a full run, which is safe and
  costs exactly the minutes covsel exists to save, while an older map recorded on an
  ancestor of `HEAD` would have selected. So an archive keeps several maps and
  `fetch` chooses: the most recently recorded map whose commit is an ancestor of
  `HEAD` first; failing that the newest commit the checkout has, which still
  selects soundly because a map's commit is diffed tree-against-tree rather than
  through a merge-base, but spans two diverged trees and so over-selects; failing
  that nothing, and the next run is a full one. Every candidate passed over is
  reported with the reason, and a fetch that finds nothing exits 0 — a CI job that
  would rather know asks with `--require`.

  `publish` refuses a map that records no commit, because nothing could measure
  change from it and every job that fetched it would fall open — the failure belongs
  to the run that recorded it, not to every pull request afterwards. It also
  refuses a commit that is not a hash, so a hand-edited map cannot decide where
  covsel writes. Publishing the same commit twice replaces it, and the archive
  keeps its 20 newest maps (`--keep <n>`).

  `fetch` will not replace a local map recorded more recently than the archived one
  without `--force`, so it cannot quietly undo a developer's own recording; CI
  never meets that case, since a fresh checkout has no local map.

  An archived map is named for the instant it was recorded and the commit it records,
  so listing an archive opens nothing — a map is not small, and parsing every
  candidate to recover two fields would mean reading hundreds of megabytes before a
  job's first test. It also means every archived file is a pruning candidate whatever
  its contents, which matters after a schema bump: judged by usability, the maps an
  upgrade invalidated would be invisible to `--keep` and would sit in the archive, and
  in every cache entry copied from it, forever. Whether a chosen map is usable is
  settled when it is opened, and an unusable one is passed over for the next
  candidate rather than failing the fetch.

  `@covsel/core` gains `publishMap`, `fetchMap`, `listArchive`, `readArchivedMap`,
  `chooseArchivedMap`, `gitCommitChecks`, `archiveDirFor`, `isAncestorCommit`, and
  `CovselConfig.store.archiveDir` (default `archive`, read relative to the store
  directory so caching the store carries the archive with it).

  covsel now uses this on itself: a `covsel map` workflow records and publishes on
  `main`, and a `select` job on every pull request fetches the map and runs the
  affected tests — alongside the job that runs the whole suite, never instead of it.

- b1b7798: Anchor selection to the commit the map was recorded on, and add shard merging
  for CI.

  Selection previously measured change from the merge-base with the default
  branch, which silently ignored anything committed since the map was recorded —
  so a map published on `main` and restored onto a later commit could skip tests
  whose code had changed in between. The diff base is now the map's recorded
  commit, compared exactly: its tree against what is on disk, rather than routed
  through a merge-base. That distinction matters, because a merge-base hides every
  file the recorded commit carries that the current history does not — checking
  out an older commit, resetting history back, or restoring a map published on a
  branch tip onto a pull request that branched earlier. When the map records a
  commit this checkout does not have, or records none at all, the window since
  recording cannot be established and selection falls open to a full run with a
  clear reason. An explicit `--since` still wins and keeps merge-base semantics.

  A discovered test file the map has no entry for now runs. Unknown coverage is
  not the same as covering nothing, and this closes the gap left by a recorder
  that yielded no units for a file, or by a merged map missing a shard.

  `mergeMaps` (and `Store.merge`) combine shard maps from a split CI suite: entries
  union by test id, granularity drops to `file` unless every shard recorded blocks,
  blocks for a test are dropped entirely when any shard recorded none for it,
  `recordedAt` is the oldest shard's, and the commit survives only when all shards
  agree. The new `covsel merge <maps...> [--out <file>]` command exposes it.

- bef646c: Combine several observation windows into one recorded unit.

  A recorded unit has carried one set of files and blocks from one observation,
  which is the whole story for every adapter shipped so far: the code under test
  runs in the process tree the recorder controls. A runner that drives a browser
  breaks that. One test spans at least two V8 isolates — the browser rendering the
  app and the worker running the spec — and usually a third, an application server.
  Each is observed by its own mechanism, and an entry built from any one of them is
  non-empty, internally consistent, deterministic, and quietly missing whole
  regions of the codebase.

  `combineObservations(test, windows)` folds them into a single unit. Covered files
  union by path and blocks deduplicate by file and hash. Blocks drop for any file a
  contributing window recorded _without_ them: that window knows nothing about
  which of the file's blocks ran, and keeping another window's would let a change
  to a block only its isolate executed miss the entry. A window that recorded
  nothing at all observed nothing execute, which is a measurement rather than
  missing block data, and costs the entry nothing.

  Scopes union, so the unit claims what its windows together could see and never
  more — `src/**` and `server/**`, never `**`. That is the opposite of the shard
  rule, where disagreeing maps claim nothing, and it follows the same invariant: no
  entry may be vouched for by a scope that was not watching that entry's execution.
  Shards observe different entries; windows observe the same execution, and the
  combined entry carries all of them. `unionScopes` and `agreedScope` are the two
  reductions, and `mergeMaps` now uses the latter.

  A window that produced nothing usable fails the whole unit, as does combining no
  windows at all. Half a test's execution recorded as all of it is exactly the map
  that skips tests, so recording fails and no map is written rather than keeping
  the half that worked.

  `recordMap` stamps the map with what the units reported, falling back to the
  recorder's declaration when they report none. Units observed through different
  window sets reduce the map's scope to claiming nothing, which falls open. What
  units report can only narrow: a unit claiming a glob its recorder does not
  declare fails the recording, because resolving that contradiction the other way
  would turn a recorder's own admission that it is blind somewhere into a map
  asserting it was watching — and every change there would then be read as a
  measurement rather than falling open. Every recorder that exists today has one
  window and reports no per-unit scope, so nothing about their maps changes.

- a5cec27: Judge a config change by what it changed, not by the file changing.

  A map is meaningful only under the configuration it was recorded with, which is
  a statement about that configuration's values. covsel read it as a statement
  about the file: any diff touching `covsel.json` or `covsel.config.js` forced a
  full run, so rewording a comment in one cost the whole suite while the map went
  on meaning exactly what it meant.

  The map now records the configuration it was recorded under, and selection
  compares the values in force against it. That is the sharper question in both
  directions: a reworded comment, a reformatted array or a moved key narrows as
  usual, while a value that moved without the diff showing it — a config computed
  from the environment, or one changed and changed back across the recorded commit
  — falls open where it used to slip through. `covsel status` and `covsel affected`
  name the fields that differ instead of naming the file.

  Four fields are excluded, because a change to one cannot leave the map meaning
  something other than what selection reads from it: `alwaysRun` and `sentinels`
  are applied from the configuration in force on every run, `store` says where the
  map is kept rather than what it says, and `adapter` names the recorder, whose
  every consequence for selection is written into the map by the recording itself.
  Everything else is compared, including fields added later.

  The comparison runs on the config file's own account, ahead of `sentinels` and
  without consulting it. A project that also lists the file in `sentinels` keeps
  the unconditional full run that declaration asks for: covsel's defaults name no
  config file, so listing one is deliberate, and the project may have a reason
  covsel cannot see from the values it reads. Dropping it from the list gives the
  narrowing and gives up nothing.

  Falling open is preserved wherever the comparison cannot be made: a map recorded
  before this existed carries no configuration and keeps forcing a full run on any
  config-file change, as does a map merged from shards that disagreed about the
  configuration they recorded under.

  `covsel explain` reports the distinction rather than promising a full run it will
  not take: `forcesFullRun` is now `{ always, why }`, where a sentinel is always
  and a config file is not.

- 1281329: Force a full run when covsel's own config file changes.

  A map is only meaningful under the configuration it was recorded with, and
  nothing was checking that. Narrowing `sourceGlobs` is the sharpest case:
  changes outside the new globs stop counting as changes at all, while the map's
  recorded `observed` scope still covers them from the wider recording — so
  neither the sentinel list nor the observed-scope check notices, and the tests
  covering those files are quietly skipped. That is the one outcome covsel exists
  to prevent.

  The check runs ahead of the project's own `sentinels` rather than being added to
  their defaults, because that list replaces wholesale when a project sets one: a
  project that tightens its sentinels should not thereby lose the protection over
  the meaning of its own map. `covsel status` and `covsel affected` name the
  config file as the reason.

- 1281329: Rename the JSON config file from `.covsel.json` to `covsel.json`.

  A committed dotfile whose name is a prefix of a generated, ignored dotdir is a
  trap: `.covsel.json` sat next to `.covsel/`, so a `.gitignore` line of
  `.covsel*` would quietly stop tracking the config. Tools that generate a dotdir
  almost always keep their config undotted for exactly this reason — `.next/` with
  `next.config.js`, `.turbo/` with `turbo.json`, `.vercel/` with `vercel.json` —
  and the undotted name also makes the committed file visible in a plain `ls`
  beside the generated directory it configures.

  The lookup order is now `covsel.json`, then `covsel.config.js` / `.mjs` /
  `.cjs`. Nothing is published yet, so there is no migration: rename the file if
  you have one, or let `covsel init` write it.

- 8e1cff2: Add `covsel watch`, which drives the record/affected/run loop continuously: it
  watches the working tree and, on each debounced batch of changes, runs the tests
  those changes affect. Change events decide only _when_ to select, never _what_ —
  every batch re-runs the same selection against the git diff — so a coalesced
  event, a renamed directory, or a platform that reports a change without naming
  the file still gets a complete answer. Source changes select through the map,
  test-file changes always run that test, and sentinel changes run everything,
  because watch calls `selectAffected` rather than restating policy of its own.
  Writes to gitignored paths do not trigger a run, since a file git ignores cannot
  appear in a diff; when git cannot answer, every path counts.

  The loop is built so it cannot quietly stop selecting. Selection that cannot be
  computed falls open to a full run with the reason printed, on every batch and not
  just the first; a failing or unstartable run leaves the watcher alive; a
  reporting callback that throws cannot kill it; and a watcher that dies stops the
  loop with a non-zero exit rather than sitting there looking healthy. Runs never
  overlap — changes arriving mid-run produce exactly one follow-up run — and the
  debounce has a ceiling, so something writing continuously next door cannot
  postpone every run indefinitely. Watching uses a single recursive `node:fs`
  watcher, with no third-party file-watching dependency.

  Re-recording the map after a green run is opt-in via `--record`, and happens only
  when the working tree is clean. A map is stamped with the commit it was recorded
  on, so one recorded mid-edit would claim to describe code that commit does not
  contain — check that commit out again and covsel would trust a map that never
  described it. `--record` therefore refreshes at each commit rather than each
  save; left alone, a map only ages, which broadens selection rather than narrowing
  it.

  `@covsel/core` gains `watchAffected`, `runAffectedSelection` (the full-run and
  adapter-narrowing split lifted out of `runAffected`, which now calls it),
  `filterUnignored`, and `isDirtyWorkTree`.

- ded16be: Add scenario-level selection for cucumber-js, the runner with no built-in test
  selection at all. The new `@covsel/adapter-cucumber` records what each
  _scenario_ executes — a support-code shim loaded through cucumber's own
  `--import` wraps every scenario with the per-scenario inspector observer — and
  `covsel run --adapter cucumber` runs only the affected scenarios via `--name`.
  Editing one source now runs a single scenario instead of the whole suite.

  Feature files are discovered automatically when the adapter is selected, so no
  configuration is needed. `@covsel/core` gains `loadRawConfig`, which reads the
  user's config without applying defaults so an adapter can supply its own test
  globs only when the project has not set them.

- 8f8a6d4: `@covsel/core` gains the three answers a dependency change turns on, ahead of
  anything reading them: `treeIsProvablyCurrent`, `changedPackages`, and
  `dependencyOnlyManifestChange`.

  `treeIsProvablyCurrent` asks whether the installed tree really reflects the
  lockfile as it stands. A lockfile pulled without an install leaves the old
  packages in place, so comparing inventories would report nothing changed and
  skip the tests for every package that did move. pnpm copies its lockfile into
  the store on every install, so the two agreeing is a proof rather than a
  heuristic — and it is the only sound check available, since "the tree shows no
  difference" proves nothing on its own when a tree stale for one reason can still
  differ for another. npm and yarn write their own install state rather than a
  copy, so the question cannot be asked of them yet. It reports why it failed, not
  merely that it did.

  `changedPackages` names the packages installed at a different set of versions
  than before, counting a removal and an appearance as changes. It is deliberately
  weaker than "the code changed", and says so: an inventory records one version set
  per name for the whole repository, so `pnpm patch` rewriting a package's source
  without moving its version, or one workspace importer swapping between two
  versions that both remain installed, compare equal. Callers may not read an empty
  result as "nothing is affected".

  `dependencyOnlyManifestChange` asks whether a `package.json` edit stayed inside
  the four dependency blocks. It is a sentinel because nearly anything in it
  changes what a test does, and the test is an allowlist rather than a denylist, so
  the next field npm invents is refused rather than admitted silently. `overrides`,
  `resolutions`, `pnpm.overrides`, and `peerDependenciesMeta` are all outside it:
  they decide what a specifier resolves to rather than what is asked for. A
  manifest that git reports as changed but which parses identically keeps the full
  run, since "nothing is known to have moved" is not "nothing moved".

  Nothing calls any of this yet, so no selection behaviour changes.

- 7b3e9f3: Resolve every adapter from the project that installed it. `covsel` now ships
  none of them.

  **Breaking -- a minor bump only because covsel is pre-1.0, where a minor may
  carry breaking changes: installing the CLI is no longer enough.** Install the adapter for your runner alongside it --
  `npm install --save-dev covsel @covsel/adapter-vitest` -- including
  `@covsel/adapter-generic` for the zero-integration wrap that `--adapter`
  defaults to. Until now the CLI depended on all five adapter packages and
  imported them statically, so every install carried four runners' worth of code
  it would never load, and a runner covsel had not adopted could not be selected
  at all without a pull request adding it to a map in the CLI.

  `--adapter mocha` now looks for `@covsel/adapter-mocha`, then
  `covsel-adapter-mocha`; a name that is already a specifier
  (`--adapter @acme/our-adapter`) is imported as written. `record`, `affected`,
  and `run` all resolve the same way, and nothing is privileged -- the adapters
  covsel publishes load through exactly the same path as one you publish, so a
  project can pin, fork, or replace any of them.

  Resolution is anchored to your project rather than to covsel's own location on
  disk, so the copy that loads is the one your project installed even when covsel
  is installed globally or you are inside a monorepo. An adapter that is not
  installed is reported with the command to install it; an adapter whose own
  dependency fails to import is reported as a load failure rather than as absent,
  because the two need different fixes.

  `@covsel/core` gains `assertAdapter(value, source)`, which narrows an arbitrary
  value to `Adapter` or throws naming the capability that is missing or mistyped.
  Core owns the interface, so it owns the runtime check for it. The strictness is
  a fail-open concern rather than tidiness: an adapter accepted but unable to
  drive its runner yields a recorder that produces nothing, and a map recording
  that a test covers nothing skips that test on every diff afterwards -- so a
  module that does not satisfy the contract is refused before recording starts.

  Each adapter package now also exports its adapter as `adapter`, which is the
  export the resolver reads (a default export works too). The existing named
  exports are unchanged.

  Fixes the CommonJS builds of `@covsel/adapter-node-test` and
  `@covsel/adapter-cucumber`, which threw `ERR_INVALID_URL` the moment they were
  required: both resolve a preload shim relative to `import.meta.url`, which is
  empty in a CommonJS bundle. Their builds now emit the compatibility shim for it.
  Only the ESM entry points were exercised before, which is why this went
  unnoticed.

- 9357ecf: Add `covsel explain <path>`, the map read in the other direction: given a source
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
  the recording. A block is only called uncovered when nothing else accounts for
  the silence — whole-file entries that select on any change to it, or drift that
  may be this very block under a new hash, are reported as what they are, since
  "no recorded test executes it" about code covsel would in fact select tests for
  sends you looking for the bug in the wrong place. Every report ends with the
  `next:` line `status` prints, because nothing about one file narrows anything
  while the next selection is a full run. Long lists are summarized with a count;
  `--all` prints them in full.

  Read-only — it changes no selection, no policy, and no schema. `@covsel/core`
  gains `explainPath` alongside `computeStatus`.

- 70f12a5: Add the file-level selection MVP: `covsel record`, `affected`, `run`, and `status`.

  `@covsel/core` gains zero-config `CovselConfig` loading, a `ProcessObserver`
  (NODE_V8_COVERAGE process mode) and `V8FileMapper`, a local JSON `Store`, a git
  diff helper, a file-level `Selector`, a fail-open `Policy` (sentinels, mandatory
  new/changed tests), and command orchestration (`recordMap`, `selectAffected`,
  `runAffected`, `computeStatus`) behind a pluggable `Recorder`. A new
  `@covsel/adapter-vitest` records with Vitest's own V8 coverage — raw
  NODE_V8_COVERAGE cannot see Vitest-transformed sources — while `adapter-generic`
  remains the default wrap for runners that execute source directly.

- b00c7cb: The generic recorder no longer claims to observe packages for a command it was
  handed. `observesPackages` says that, had a test executed any package's code
  anywhere, this recorder would have seen it — and the wrap knows only that it
  spawned an argv somebody typed with `NODE_V8_COVERAGE` set and read the dumps
  that appeared. A command that drives a browser, shells out to another runtime, or
  runs its tests in a container executes code that dump never sees, and looks
  exactly like `node --test` from here.

  The claim matters because of what it licenses. An entry's `packages` is paired
  with an inventory of what was installed, and a package in the inventory that no
  entry credits reads as _installed and never ran_, so a bump to it need select
  nothing. Claimed for a command whose code runs elsewhere, that reading is applied
  to every dependency the recording never watched — and a browser-only dependency
  moving would skip the tests that exercise it. Withholding the claim gives up the
  precision a bump could have had; making it wrongly skips tests.

  Neither the command nor the recording can settle it. An allowlist of runner
  binaries still declares for `node run-e2e.mjs` and declines for a shell wrapper
  around `node --test`, which is a wrong guess that reads like evidence. Inferring
  from the dump can only refute the claim, never establish it: vendored code in the
  dump is equally consistent with having missed every package that ran in another
  isolate, which is precisely the situation under a browser-driving runner whose
  own Node-side dependencies are in there.

  So the claim belongs to whoever chose the command. `createGenericRecorder` takes
  `runsInNodeProcessTree`, the caller's assertion that the run executes everything
  under test in the process tree covsel spawns, and declares `observesPackages`
  only when it is set — attributing packages exactly when it stands behind them,
  so a unit is silent about them exactly when its recorder is.
  `@covsel/adapter-generic` never sets it, because wrapping whatever it is handed
  is what the adapter is for. A recording made through it now carries no `packages`
  on any entry and no `dependencies` inventory, so it holds no opinion about a
  dependency change and answering one is left to the lockfile sentinel, which the
  default `sentinels` cover for every package manager covsel recognises.

  `observes` stays `OBSERVES_EVERYTHING` on the same recorder. The uncertainty is
  identical, but the two claims do not have the same expressive range: withholding
  a boolean states it exactly, while `observes` is a set of repo-path globs and
  what an unvouched command hides is a process boundary — globs name where in the
  repo a path is, never which process ran it. The only narrowing available is the
  empty scope, which does not narrow the claim so much as withdraw selection from
  covsel's default adapter entirely, and that is not a decision to make as a side
  effect of this one.

- e406004: Admit only the granularities covsel records at, and refuse a map or a config
  naming another.

  `Granularity` was `'file' | 'block' | 'line'`. Nothing wrote `'line'` and
  nothing read it: no recorder produced it, `CovselConfig.granularity` never
  offered it, and every downstream check spells the question `granularity ===
'block'`. It was a variant of a versioned on-disk contract that could not occur
  — the map promising a meaning covsel had no way to supply.

  `isUsableMap` did not validate the field either, so a hand-written map claiming
  `'line'` was accepted and then degraded to whole-file selection. That is the
  safe direction, but by luck rather than by design: one check written `!== 'file'`
  instead of `=== 'block'` would have had it selecting by blocks the entries never
  carried, which skips tests.

  `'line'` is now gone from the type, and it is not coming back under another name.
  Blocks are fingerprinted by content precisely so the map survives reformatting
  and line shifts; a line-keyed map goes stale on a change that alters no behaviour
  at all. The want behind "line" is smaller blocks, and that is an argument about
  block extraction, not about line numbers.

  `GRANULARITIES` and `isGranularity` are exported, and both ends now check:

  - `isUsableMap` rejects a map whose granularity is not one covsel records at, so
    it reads back as no map and selection falls open to a full run. Rejecting
    rather than degrading to whole-file keeps the guarantee independent of how a
    later reader spells its check — an unrecognized granularity is refused before
    anything reads the entries.
  - `resolveConfig` throws on an unsupported granularity, naming `file` and
    `block`, instead of resolving it to a value the project never asked for. It
    cannot cost a test: nothing has been selected at the point it fails.

  **Migration: no map needs to change, and there is no schema bump.**
  `MAP_SCHEMA_VERSION` stays at 2. No map in the wild can contain `'line'`, since
  nothing ever wrote it, so bumping would invalidate every stored map — a full
  recording run for every user — to reject a value none of them have. Maps
  recorded at `file` or `block` keep selecting exactly as they did.

  **One config does need editing, and this is the breaking part.** A `covsel.json`
  or `covsel.config.js` naming a granularity covsel does not implement used to
  resolve through and record at `block` or `file` anyway; every command now fails
  under it. Change such a value to `block` (the default, function-level) or `file`.
  An explicit `null` still means "unset" and takes the default, as it does for
  every other field.

  Two maps do become unusable, and both fall open to a full run rather than
  selecting anything: one hand-edited to a granularity covsel does not implement,
  and one missing the field entirely. Neither is a shape covsel has ever written —
  every recording and every merge stamps a granularity — so in practice this is a
  guard against hand-edited and foreign maps, not a migration. A project that
  recovers by re-recording gets a map identical to the one it had.

- 1281329: Add `covsel init`: set a project up for covsel in one command. It reads
  `package.json` to work out which runner the project uses, shows what it found,
  and — once you confirm — installs that runner's adapter with the project's own
  package manager, writes the adapter to a `covsel.json`, and keeps the map
  directory out of version control.

  Now that covsel ships no adapters, which package to install is the first
  question in adopting it, and the answer is already in the project's
  dependencies. `init` also installs what recording needs beyond the adapter
  itself — Vitest's coverage provider, which the Vitest adapter reads through — so
  setup does not end with a config that looks complete and fails at the first
  `record`.

  Detection is shown before anything happens, because detection can be wrong and a
  wrong adapter is a config that looks settled while recording nothing useful.
  `--auto-approve` carries the plan out without asking, `--no-install` plans to
  configure without installing, and `--adapter <name>` names one yourself. If the
  install fails, the config is still correct and the exact command that finishes
  the job is printed rather than left implied.

  `CovselConfig` gains an optional `adapter`, which `record`, `affected`, `run`,
  and `watch` fall back to when `--adapter` is not given — the flag still wins, and
  an unset field still means the default. It is the one config field with no
  default in core, because core cannot name an adapter that is certain to be
  installed.

  `init` does not guess. A runner covsel has no signature for is reported rather
  than resolved to the generic wrap on the theory that something beats nothing: it
  writes nothing, prints the environment an adapter request needs — covsel
  version, Node version, platform, package manager, the test script and
  test-related dependencies — and links the prefilled issue. That link carries only
  versions and platform; the project's own strings stay in the local output for
  review, since the tracker is public. A project running a suite covsel cannot
  record yet (Playwright) is told to keep running it in full.

  For programmatic use, `planInit` works out what would happen and touches
  nothing, and `applyInit` carries a plan out; a plan that could not name an
  adapter is inert when applied.

- 89a25dc: `covsel init` now installs the adapter before it writes the config, so a name
  nothing provides leaves no config behind. Previously `covsel init --adapter
nope` wrote a `covsel.json` naming `nope` and then handed `@covsel/adapter-nope`
  to the package manager, so a registry 404 was the first anyone heard of the
  mistake — with a project already configured for an adapter that does not exist,
  which every later command then failed on.

  The install is the check. covsel keeps no list of adapter names that count:
  anyone can publish an adapter, so any name is a candidate, and whether one has a
  package behind it is the registry's answer to give. `init` asks the package
  manager for `@covsel/adapter-<name>` and, if that comes back empty-handed, for
  `covsel-adapter-<name>` — so an adapter published only under the community prefix
  now installs from `--adapter <name>` instead of failing on a specifier that was
  never published.

  The fallback to the community prefix is for a specifier the package manager
  turned down, not for a run that never finished: an interrupted install stops
  there rather than escalating into a request for a differently-named, unscoped
  package the caller never asked for. Support packages such as
  `@vitest/coverage-v8` are installed once the adapter is in, so a failure that is
  theirs is reported as theirs instead of blamed on the adapter.

  When no specifier can be installed, the failure names every command covsel asked
  the package manager to run, suggests the adapter the name is a near-miss of when
  there is one, and says that no config was written. It does not claim the package
  does not exist: a private registry, an offline machine, and a name with nothing
  behind it all look the same from here. A project that was already configured is
  told its config is unchanged, rather than a "nothing was written" that would read
  as a rollback covsel never performed. Ignoring the map directory goes ahead
  either way — whether covsel can record has no bearing on whether its output
  belongs in version control, and it was a line of the plan the caller agreed to.

  `--no-install` is deliberately exempt. It says the project brings its own
  packages, which leaves no install to answer the question, so the config is
  written on the caller's word — the way in for an adapter arriving from a private
  registry, a lockfile, or a workspace link.

  `@covsel/core` gains `knownAdapters()` and `suggestAdapter()`, read off the
  runner table so a new adapter joins the suggestions along with its runner. They
  are help after a failed install, never a gate: an adapter covsel has never heard
  of is as acceptable a name as one it ships an adapter for.

- 3cc55e7: Add `InspectorObserver`, the Level-1 (per-test) observation primitive. It
  snapshots V8 precise coverage before and after each test via the inspector and
  diffs the counts, attributing execution to the individual test rather than the
  whole file, all within one process. Its output is V8 ScriptCoverage-shaped, so
  it feeds the existing `V8FileMapper`. A runner adapter drives it by calling
  `startTest(id)` / `endTest(id)` around each test — the only per-runner code. An
  integration test guards the mechanism: two tests sharing a module are each
  credited with only the sources they executed. Wiring it into a runner and the
  per-test selection pipeline is a follow-up.
- dbaf1b5: The installed-package inventory now records **resolution edges** rather than
  versions, and `MAP_SCHEMA_VERSION` is 5. Every stored map is invalidated: covsel
  rejects a map written under an older schema, which forces one full run with a
  log line saying so, and recording again restores selection.

  A version set answers "which versions are installed somewhere in this
  repository". That is not the question. The question is whether the code a given
  test runs has moved, and two ordinary situations move it while leaving every
  version in place:

  - **`pnpm patch`** rewrites a package's source and keeps its version. The
    lockfile gains a `patchedDependencies` entry, the tree is provably current,
    and no version moves anywhere.
  - **A workspace importer swapping between versions others still hold.** With
    `a` and `c` on `is-odd@3.0.1` and `b` on `2.0.0`, moving `a` to `2.0.0` leaves
    the repo-wide set `{2.0.0, 3.0.1}` unchanged while `a`'s tests begin executing
    different code. It takes a third importer to see this at all: with only `a`
    and `b`, `3.0.1` disappears and the change is obvious.

  Both would have read as "nothing changed", and a selection built on that reading
  skips the tests that run the moved code.

  An edge is `<who resolved it>:<what they got>` — the importer or store entry
  holding the link, and the identity it points at. For pnpm the identity is the
  store entry name, which is the resolution identity pnpm already computed:
  `is-odd@3.0.1`, `is-odd@3.0.1_patch_hash=00bb…` once patched,
  `vite@8.0.0_@types+node@22.0.0` once peers are resolved. Everything a version
  cannot say about which code this is, that name says. A package outside any store
  — a hoisted tree, a bundled dependency — is identified by where it really sits
  plus the version it declares, since there the path alone does not say.

  Measured against real `pnpm install`: both situations above are now detected,
  and an ordinary bump of one of two dependencies still names exactly the one that
  moved. That control matters as much as the fixes — a change that caught both
  failures by over-selecting would have bought nothing.

  An identity names the store it came from as well as the entry, because a
  repository can hold more than one — a nested example app or an end-to-end
  project with its own lockfile is walked like any other — and two stores name
  their entries independently. Comparing bare names would let a change in one
  cancel out a change in the other.

  A package whose store entry names a directory rather than its contents — a
  `file:` or `link:` dependency, copied into the store under a name built from the
  path it came from — can have its source edited and reinstalled without the
  identity moving. Those are left out of the inventory and keep falling open, and
  so is anything such an entry resolved, since otherwise the path it is named for
  (which may sit outside the repository entirely) is written into a map that gets
  published.

  A store entry's link to its own package is dropped where another edge already
  names that copy, which is most of the time — a third of the edges recorded on
  this repository. Not always, though: when the link that reached the entry was
  itself dropped, as an aliased install's is, the self-edge is the only thing
  naming that copy, and discarding it would lose the package rather than a
  redundancy.

  `changedPackages` is unchanged; it compares the same shape it always did.

- 9241c52: Answer `affected`, `status`, and `fetch` as data, with `--format json`.

  Everything covsel says about a selection was prose meant for a person: `affected`
  printed a file list, `status` an aligned report, `fetch` English sentences on
  stderr. A CI job that wants to _report_ what covsel decided — a step output, a
  job summary, a shard matrix — had to scrape those, and scraping breaks the first
  time a sentence is reworded. This is the surface any CI integration, ours or
  anyone else's, has to be built on.

  - `--format json` on `affected`, `status`, and `fetch` writes one object on one
    line to stdout. The human lines stay on stderr, where `affected` and `fetch`
    already put them, so a job piping stdout into a parser keeps the log a person
    reads beside it. `status` is the exception and the object replaces its report,
    because that report _is_ its stdout and the two cannot share the stream.
  - Exit codes do not depend on the format. `fetch` finding nothing is still
    `ok: false` and still exits 0 — the tests still have to run, and they run in
    full — and `--require` still turns that into a failure.
  - A full run still enumerates every discovered test file; `fullRun` and `reason`
    are what say the list is not a selection. Emptying the lists there reads like
    tidiness and is the one shape that turns `covsel affected --format json | jq -r
'.files[]' | xargs <runner>` into a command that runs no tests, on exactly the
    runs that need every one. The CI guide says to branch on `fullRun` and run the
    suite unfiltered, and a test pins the shape.
  - `--format` with nothing after it is now an error rather than the default.
    `covsel affected --format "$FMT"` with `FMT` unset produced exactly that argv,
    and answering a pipeline that asked for data with prose leaves its parser
    reading an empty answer.
  - `affected` reports `files` and `tests` separately: `files` is the adapter's
    runner-native rendering, identical to what `--format files` prints, and `tests`
    the plain test files behind it. They are the same list until selection is
    per-test, and a job sharding the suite needs the second.
  - `AffectedResult.discovered` is new: the test files discovery found, whether or
    not they were selected. It is the denominator a selection only means anything
    against — one test chosen out of two and one chosen out of two hundred are the
    same `tests` list and completely different news, and a `testGlobs` that stopped
    matching looks like a very precise selection without it. **Breaking for anything
    that constructs an `AffectedResult`** rather than reading one — a custom
    `select` passed to `watchAffected` is the case in practice — since the property
    is required. Reading one is unaffected.
  - `StatusResult.commit` is new, and `covsel status` prints a `commit:` line. The
    commit a map records is the tree selection measures change from, which is the
    fact the whole CI recipe turns on, and it was the one thing the report did not
    say. A map recording none reads `none recorded`, which is why the `next:` line
    below it says full run.
  - Absent keys in the JSON mean unknown, never zero. A map covsel could not read
    has no `entryCount`; a key reading `0` would describe an empty map instead of
    an unreadable one.

- 94f8d85: Add per-test selection for Mocha, and prove the file-level path it builds on.

  Mocha was the one runner covsel made a claim about without shipping anything for
  it: the docs said it worked through the generic `NODE_V8_COVERAGE` wrap, on the
  argument that it executes source directly, but nothing exercised that. The new
  `examples/mocha-basic` is that proof — record, select on a scripted diff, run
  only the affected spec — and it passes with `@covsel/adapter-generic` untouched,
  so file-level selection for Mocha needs no Mocha-specific code and CI now runs
  the loop on every push.

  The new `@covsel/adapter-mocha` exists for what the wrap cannot do: narrowing a
  run below the file. A root hook plugin loaded through Mocha's own `--require`
  drives the per-test inspector observer, so each test becomes its own map entry,
  and `covsel run --adapter mocha` invokes Mocha over the affected spec files under
  a single `--grep` matching the affected tests' full titles. Editing one source
  now runs one test instead of its whole spec file. Specs are discovered
  automatically when the adapter is selected — `test/**` with Mocha's own
  extensions, plus the `*.test.*` / `*.spec.*` convention — so a Mocha project
  needs no `testGlobs` of its own. Recording forces `--no-parallel`: Mocha's
  parallel workers run the root hooks in a process other than the one covsel reads
  the result from, which would produce a map crediting nothing from a run that
  reported success.

  `covsel init` now names `mocha` rather than `generic` for a project that depends
  on Mocha, so its recording selects per test from the start. A project already
  configured for the generic adapter keeps working exactly as it did.

  `@covsel/core` gains `testNamePattern`, the escaped and anchored regex that folds
  several affected test names into the one filter a runner accepts. All three
  per-test adapters now share it instead of each carrying a copy: an unescaped
  title containing `+` or `(` compiles to a valid pattern that matches no test, so
  the run passes having executed none of the affected tests.

- 505db55: Exclude a nested function's body from its enclosing function's block hash, and
  bump `MAP_SCHEMA_VERSION` to 4.

  `extractBlocks` canonicalized the module block with every outermost function body
  blanked out, so an edit inside a function did not change the module's hash. It
  did not do the same one level down: a function block was canonicalized with an
  empty exclusion list, so **a function's hash included its nested functions'
  bodies verbatim**. Editing an inner function changed every enclosing function's
  hash, and any test that executed an enclosing function was selected.

  That is over-selection — safe, and invisible unless you look for it — but it is
  where block precision goes to die in component frameworks. React, Vue, and
  Svelte all put handlers, effects, and callbacks _inside_ a component function, so
  every edit to any of them selected every test that rendered the component: block
  granularity silently collapsed to component granularity, for every runner that
  records blocks. Measured on a component with two specs, one clicking its button
  and one not, editing the click handler selected both. It now selects the one that
  clicked.

  A block's hash now covers its own signature and its own statements, with the
  bodies of the functions nested inside it blanked the way the module block already
  blanks outermost ones — the same rule at every depth rather than only at the top.
  The blocks emitted, their names, their order, and their coverage probes are
  unchanged, and hashes remain stable across reformatting.

  A block is also hashed under its position in the nesting now — the chain of
  enclosing functions, each with an index among the same-named blocks of its scope
  — because blanking a body out of the parent is sound only while the child block
  covers it _distinguishably_. Two sibling callbacks that share a name hash to each
  other's values when their bodies are exchanged, and blocks are compared as a
  multiset, so reordering them would have registered as no change to any block in
  the file. `<anonymous>` makes that the ordinary case rather than an exotic one:
  two `useEffect` calls in one component are two same-named siblings, effect order
  is behavior, and the enclosing function's hash used to catch the reorder only
  because it carried both bodies. It now catches it in the callbacks themselves.
  The cost is that inserting or moving a same-named sibling shifts the indices
  after it and re-selects their tests, which is the safe direction. This also
  closes the same hole at module scope, where two anonymous top-level callbacks
  could already be permuted without changing any hash.

  **A nested function's signature stays with its parent.** Only the body is the
  child's. The parent evaluates the function expression, so the parameter list and
  the position among the parent's statements are the parent's own code, and
  changing them selects the parent's tests as well as the child's. It is the same
  treatment the module block already gives top-level functions, and it is the
  fail-open direction: the alternative moves code out of every enclosing block
  without moving it into any other.

  **Migration: this is a breaking change to persisted state.** Every block hash
  changes, so every stored map recorded at `block` granularity is invalidated at
  once. `MAP_SCHEMA_VERSION` goes from 3 to 4, which means covsel rejects those
  maps outright and falls open to a full run rather than selecting against hashes
  that can no longer match anything. Re-record to get selection back:

  ```bash
  covsel record -- <your test command>
  ```

  Until then `covsel status` reports the map as present and unusable, naming the
  schema it found and the one this build reads.

- a9bbe19: Record what a recording could observe, and fall open on changes outside it.

  A map says which files each test covered. It could not say whether "not covered"
  means "did not run" or "ran somewhere the recorder was not looking" — and
  selection read it the first way. That is safe for every adapter shipped so far,
  because each observes the code under test in the process tree it controls, so
  absence really is a measurement. It stops being safe the moment a recorder sees
  only part of a test's execution: a browser but not the server behind it, one
  isolate of several. Such a recorder produces a map that is non-empty,
  internally consistent, deterministic, and quietly missing whole regions of the
  codebase, and selecting on it skips tests the change breaks.

  `Recorder` now carries `observes`, the repo-relative globs it is able to see
  execution within, and `CoverageMap` carries the `observed` scope it was recorded
  with. A change to a path outside that scope forces a full run, naming the path.
  Recorders that would see any path that ran declare `OBSERVES_EVERYTHING`, which
  is what the generic, Vitest, Jest, node:test, and cucumber recorders do, so
  selection
  is unchanged for every adapter that exists today.

  The declaration is required rather than defaulted. A map that does not state its
  scope is not usable, because the only available guess — "it observed everything"
  — is exactly the guess that loses tests. `MAP_SCHEMA_VERSION` moves to 2, so
  maps recorded before this change fall open to a full run rather than being read
  under the new rule.

  The scope is matched strictly, unlike every other glob set in covsel. The shared
  matcher widens slash-less globs to match a basename anywhere, which is right for
  sentinels, test globs, and always-run globs, where a wider match runs more tests.
  The polarity inverts here: a path wrongly counted as observed suppresses the full
  run it should have caused, so `makeStrictMatcher` reads these globs as written.

  `mergeMaps` keeps the scope only when every shard agrees on it, and otherwise
  produces a map claiming nothing, which falls open on any change. Unioning would
  let one shard's coverage vouch for paths another shard was never watching. The
  CLI says so on merge, and `covsel status` reports the observed scope alongside
  granularity.

- 7886f0b: Add per-test selection for Node's built-in test runner. The new
  `@covsel/adapter-node-test` records each test individually — a preload shim
  drives the Level-1 `InspectorObserver` around every test via node:test's
  `beforeEach`/`afterEach` — and `covsel run --adapter node-test` runs only the
  affected tests using `--test-name-pattern`. Two tests in one file that execute
  different sources are now selected independently; editing one source runs only
  the test that touched it.

  Per-test observation is at source-file granularity: V8 precise coverage reports
  only the functions that ran, so it reliably tells which files a test executed
  but not which un-run functions to exclude on a shared file — per-function
  precision under per-test observation is left to the whole-file recorders.

  `@covsel/core` generalizes the `Recorder` contract to return one `RecordedUnit`
  per test (`record(): Promise<RecordedUnit[]>`), `recordMap` writes one map entry
  per test, and `selectAffected` returns the selected test units (`selected`)
  alongside the file list. The generic and Vitest recorders return a single
  whole-file unit and are otherwise unchanged.

- 049ee96: Carry the mapper's configuration into the per-test recorders.

  The node:test and cucumber adapters map coverage inside the runner they spawn, and each was handing that runner three configuration fields it had picked by hand. `sourceMaps` was not among them, so `allowUnmappable`, `buildDirs`, and `http` were inert for both: a project whose tests reach their code through a build with no source map could accept that gap in its config, watch the generic wrap honor it, and still find recording impossible under either per-test adapter. The failure direction was safe — recording refuses rather than crediting nothing — but it was total, and nothing said why, because the setting had simply never arrived.

  Both recorders now carry exactly what the mapper reads, and both report the scripts it let through, so `covsel record` names accepted gaps whichever adapter produced the map. `@covsel/core` exports the `MapperConfig` type and `toMapperConfig` to make that one narrowing rather than one per adapter, and `toMapperConfig` names every key under a type that requires all of them — including optional ones, which is how `sourceMaps` was dropped in the first place. Adding a field to what the mapper reads now stops the carriers compiling.

  Recording also drops what a failed file let through unmapped before moving to the next one. A recorder that accumulates across files would otherwise carry it forward, and the next file's progress line would name a script that file never executed.

- 8d54ff3: Add `@covsel/adapter-playwright`: per-test selection for Playwright, recorded
  from what each test executed **in the browser**.

  E2E minutes are the most expensive minutes in CI, and static selection cannot
  help — Playwright's own `--only-changed` walks the import graph of the spec
  files, which cannot see through the HTTP boundary to know which application code
  a spec exercises. This records what does run there.

  Recording is one `playwright test` invocation, so the `webServer` boots once. An
  auto-fixture the project installs on its own `test` object collects Chromium's V8
  coverage around each test and projects it back through the application's source
  maps, in the Playwright worker — where a dev server's modules are still
  reachable. `covsel run` hands Playwright the affected spec files narrowed by
  `--grep`.

  It observes the browser and nothing else, and says so: the project declares
  `observes`, that scope is stamped into the map, and every change outside it
  forces a full run rather than being read as code no test covers. A server change
  falls open; a click handler change selects the one test that ran it.

  Supporting changes in `@covsel/core`:

  - **`observes` in the project's configuration.** Which repo paths reach a browser
    depends on the build layout and where the server lives, neither of which an
    adapter can infer, so the project states it. Most recorders work it out for
    themselves and ignore this; one that cannot refuses to record without it,
    because both defaults are wrong — `**` skips tests, nothing at all turns every
    recording into a full run.
  - **`testNameSuffixPattern`.** Playwright matches `--grep` against a title it has
    prefixed with the project name, so a pattern anchored at the front would name
    one browser and select nothing at all under the others.
  - **A source named relative to the script that was served now resolves.** Vite
    and its family answer `/src/cart.ts` with a map naming `cart.ts`; read against
    the repo root alone that source is looked for at the top of the tree and
    reported as coverage the recording could not locate, which fails every
    dev-server recording. The URL's own directory is now tried first, still
    confirmed against the text the build published.
  - **`covsel init` names the Playwright adapter** for a project that has
    `@playwright/test`, and names Cypress as a runner no adapter records yet.

  The adapter also observes the **application server** when the project asks it
  to, so a change there selects the tests that reached it instead of falling open:

  ```ts
  export const test = base.extend(
    covselFixtures({
      browser: { observes: ['src/**'] },
      server: { observes: ['server/**'], inspectUrl: 'http://127.0.0.1:9229' },
    }),
  );
  ```

  It opens a Node inspector session per test against the server Playwright already
  started — nothing of covsel runs inside it — and each window declares what it
  alone could see, so a browser recording never vouches for the server. Recording
  needs `--workers=1` when the server window is on, and the fixture refuses rather
  than credit one worker's server execution to another's test. The server window
  tells covsel less than the browser window does: coverage starts when the test
  does, so a module the server loaded at boot reports only the functions that ran
  and covsel reads the rest as executed — file granularity, fail-open. A module
  first imported during the test keeps real block granularity.

  Both configurations run the shared conformance suite, against a real browser and
  a served application, in their own CI job.

- 7a64bfc: `V8FileMapper.toBlocks` now projects a source-mapped script's coverage onto the
  sources behind it, so a bundle contributes blocks instead of nothing. Previously
  only a script whose bytes were the bytes on disk produced blocks, and anything a
  bundler fused fell back to whole-file selection. A source is projected only while the
  build's published `sourcesContent` still matches the file, since a map's
  coordinates describe its sources as they stood at build time; anything else stays
  at file granularity. `SourceMapResolver` gains `resolveProjectable`, which returns
  the map and the script text alongside the resolved sources for immediate use, and
  `ScriptCoverage` gains an optional `source` for observations that carry the
  script's text, as browser coverage does.
- 6071216: Add `projectRanges`, which turns a script's V8 coverage ranges plus its source
  map into executed regions in the original sources' own offsets, ready for
  `selectExecutedBlocks`. Every range is projected, anonymous functions included,
  and ranges that reach no original source are reported as unprojected rather than
  attributed to one. Also exports `decodeMappings` and `indexedSources`.
- 47044db: A recorder can now record the whole suite in one invocation, returning a unit per
  test, by implementing `recordRun(testFiles)` instead of `record(testFile)`.
  Recording reconciles what comes back against the files it asked for, so a test
  file the run never reported fails the recording rather than being written as
  silence. `Recorder.record` is now optional; a recorder must implement one of the
  two, and recording refuses one offering neither. The conformance kit drives
  either mode.
- 6e777ed: A recording can now capture which installed packages each test executed, and what
  was installed at the time, for a recorder whose caller vouches that the run
  executes everything under test in the Node process tree covsel spawns. Nothing
  selects on it yet — every lockfile change your `sentinels` name is still the full
  run it is today — but both halves are on disk and inspectable.

  `MapEntry` gains `packages`, the names of the packages a test ran code in.
  `CoverageMap` gains `dependencies`: the package manager, its install marker and
  that marker's hash, and an inventory of every installed package with the
  versions it was resolved to. The inventory is what makes silence readable. A
  changed package inside it that no entry mentions was watched and never ran, so
  nothing need be selected for it; a changed package absent from it is one the map
  never had an opinion about, and falls open. Without it the two are
  indistinguishable and everything falls open.

  The marker is the freshness proof, and it is not optional. A lockfile pulled
  without an install would leave the tree looking unchanged, and "nothing changed"
  computed against a stale install is the answer that skips tests. pnpm writes a
  byte-identical copy of its lockfile into the store, npm a hidden lockfile, and
  yarn its install state; bun and yarn's PnP linker write nothing usable, so a
  project on either records no `dependencies`, and nothing measures what it
  installed — a change there is answered by whatever its `sentinels` name, and the
  default list names every lockfile covsel recognises, bun's included. So does a
  tree carrying two managers' markers, where which install it reflects is
  unknowable.

  A package reaches a test two ways and both are counted: it executes as its own
  script under `node_modules`, which is a path question, or a bundler inlined it
  into built output and nothing under `node_modules` ever runs, in which case only
  the built script's source map names it. Reading the first and not the second
  would leave the package in the inventory with no entry crediting it.

  For the same reason, a package whose identity does not survive resolution stays
  out. The walk sees `node_modules/<name>`; V8 reports the realpath of whatever
  executed. A linked workspace package resolves to `packages/<name>` and its
  coverage arrives as first-party source; a package linked from outside the
  repository resolves out of the tree entirely; a pnpm aliased install resolves to
  the store entry for the package it aliases. No entry can name any of them, so
  each is dropped and falls open. Ordinary pnpm installs are unaffected, since a
  store path still reads as the package it holds. The walk also dedupes by
  realpath, without which a monorepo whose workspace packages link to each other
  walks a cycle rather than a tree.

  `Recorder` gains `observesPackages`, a claim `observes` cannot express — `**`
  already matches every `node_modules` path, so no scope distinguishes a recorder
  that watches vendored code from one that never sees it. Only a recorder reading
  a raw `NODE_V8_COVERAGE` dump is in a position to declare it: a runner's own
  coverage provider drops `node_modules` before covsel sees anything, and a
  per-test window opened in a `beforeEach` misses whatever ran while the module
  graph was evaluating.

  Recording **fails** a declaring recorder whose unit omits `packages`, since
  there is no safe way to guess what it ran. The reverse is only declined: a unit
  reporting packages its recorder has not claimed to watch has them dropped, and
  the map keeps none. Adapter authors who wrap another recorder and forward its
  units under their own declaration lose the feature rather than the recording.

  Packages a recorder could never observe stay out of the inventory. A platform
  binary whose whole payload is an executable, or whose only entry point is a
  `.node` addon, can never be credited to a test — and a package in the inventory
  that no entry credits reads as "ran nowhere", which is the reading that skips
  tests. So does a types package: `"main": ""` is how DefinitelyTyped says there
  is nothing to run, and an `exports` map offering only a `types` condition names
  a declaration file no runtime executes. A JS wrapper around a native addon does
  qualify and stays: the wrapper executes, and covsel sees it.

  `mergeMaps` intersects inventories across shards, the analogue of `agreedScope`
  and safe for the same reason — a smaller inventory falls open more. Shards whose
  markers disagree installed different trees and yield no `dependencies` at all,
  as does any shard silent about packages.

  `MAP_SCHEMA_VERSION` is 3. Every stored map is invalidated, which forces one
  full run with a log line saying so; recording again restores selection.

- 6c318cc: Sentinel the files that decide how a lockfile becomes a `node_modules`, and stop
  vouching for a package whose layout cannot say which code is there.

  Two gaps found by independent review of the dependency-inventory work, both
  fail-closed, and both between the inventory and any use of it.

  **`.npmrc` and friends are now default sentinels.** A lockfile says which
  packages are installed; these say where they are put and what resolves to them,
  and the two are independent. pnpm's `hoist-pattern` fills
  `node_modules/.pnpm/node_modules/`, the fallback that resolves undeclared
  ("phantom") imports for everything in the store. Narrowing it removes that
  directory and an import that worked becomes `MODULE_NOT_FOUND` — with the
  lockfile unmoved, no sentinel firing, and the inventory none the wiser, since it
  never enters a dot-directory. A selection was computed against a resolution that
  no longer held. `.pnpmfile.cjs` is worse: it rewrites manifests at install time,
  so it can change what any package depends on without appearing anywhere else.
  `.npmrc`, `.pnpmfile.cjs`, `.yarnrc.yml`, `.yarnrc`, and `bunfig.toml` join the
  lockfiles in `DEFAULT_CONFIG.sentinels`. A project holding one of these files
  and setting no `sentinels` of its own will see a full run where it previously saw
  a selection, which is the direction that cannot skip a test. Settings made
  outside the repository — `~/.npmrc`, `NPM_CONFIG_*` — remain beyond what any
  sentinel can see.

  **A package outside a store is left out of the inventory.** Its identity was the
  path plus the version its manifest declares, and a version is not a content
  signal: `pnpm patch` rewrites the files and leaves the version alone. Under
  `node-linker=hoisted` every package is in that shape, the freshness proof still
  passes, and a patched dependency would read as "installed and never ran" — the
  inference that skips the tests running the patched code. Such a package now falls
  open, exactly as one whose store entry names a `file:` directory already did.

  Hashing the files would give those layouts a real identity, and was measured
  rather than assumed: 700 packages of this repository are 281 MB across ~25,000
  files and take 14 seconds to hash. That is not a price to add to every recording,
  and no cheaper signal is honest — sizes and timestamps both report "unchanged"
  for edits that are not.

  The cost is worth stating plainly. A project on `node-linker=hoisted` now records
  no inventory, so every dependency change falls open to the lockfile sentinel,
  which is what covsel does today for every project. npm and yarn trees are the
  same shape; their inventories were already unusable for want of a freshness
  proof, but this is a second thing they need before they can select, rather than a
  detail of the first. A default pnpm tree is unaffected — measured on this
  repository, all 1,367 edges across 611 packages come from store entries and not
  one reaches the fallback.

  An inventory that ends up vouching for nothing is now reported as no inventory at
  all. Both have to fall open, but they are not equally hard to get wrong: a
  missing `dependencies` field is what every map recorded before that field existed
  presents, so no consumer can overlook it, while an inventory that is present and
  empty is a second rule — and forgetting it means diffing `{}` against `{}`,
  finding nothing changed, and skipping the suite.

- 861ce05: Select on a dependency change instead of falling open on every lockfile diff.

  Phase 3 of covsel/covsel#47. A lockfile change was a full run, and dependency
  bumps are among the most frequent diffs a repository sees — on a busy repo that
  single trigger can account for more full runs than every source change combined.
  The information needed to do better has been recorded since #71 and #84 and read
  by nothing. Now it decides.

  When a diff's only dependency-related changes are lockfiles and `package.json`
  edits confined to their dependency blocks, covsel resolves them to the set of
  packages whose resolution actually moved, and selects the tests whose entries ran
  code in one of those packages. A bump to a package one test executed runs that
  test. A bump to a package no test executed runs nothing.

  That downgrade of the lockfile sentinel is the only one covsel makes, and it
  holds only when every precondition does. Each rules out a way the comparison
  could be a lie rather than a measurement:

  - **The map recorded an inventory.** Without one there is no "before" side. Every
    map recorded before that field existed is in this position, and takes the path
    it always did — the sentinel fires, in its own words. That is deliberate: it is
    not a downgrade that failed but a question the map cannot be asked, and a
    project that dropped lockfiles from its `sentinels` keeps the behaviour it
    chose rather than being overruled with a full run it decided not to spend.
  - **The tree provably reflects the lockfile.** A lockfile pulled but not
    installed leaves the old packages on disk, so diffing inventories would report
    nothing changed and skip the tests for everything that really moved. pnpm
    writes a byte-identical copy of its lockfile into the store on every install,
    and comparing the two is the whole proof. Note the asymmetry that makes it
    necessary: "the tree shows no difference" is not a safe test on its own,
    because a tree stale for one reason can still differ for another.
  - **The tree still yields an inventory now.** No "after" side, no comparison.
  - **Every changed package was installed at record time.** One that was not is a
    package the map never had an opinion about, and its silence is an artifact
    rather than a measurement — the same distinction `observed` draws for paths.
  - **Both sides used the same package manager.** A repository that switched
    between recording and now satisfies the freshness proof and nothing else.

  A manifest edit is admitted only when every changed `package.json` moved nothing
  but its dependency blocks. The sentinel matches every workspace manifest, so the
  question is asked of each one: a `scripts` block edited in one package changes
  how that suite runs whatever the others did.

  Package changes are a separate axis from file changes, and deliberately not
  synthesised as `Change` records with `node_modules/` paths. Those paths are
  outside every recording's `observed` scope by construction, so each one would
  trip the unobserved-change rule and force the very full run this exists to avoid.

  `status` takes the same step in the same order as `affected`, so it cannot
  announce a full run the selection then downgrades.

  Also new: `fileAtCommit`, which reads one file as of one commit — the "before"
  side of a manifest diff, for the cases where knowing _that_ a file changed is not
  enough and what changed inside it decides the answer.

  Only pnpm can reach the selecting path today, because only pnpm's marker is its
  lockfile. npm and yarn keep falling open, now for two reasons rather than one:
  they leave no comparable freshness proof, and their flat `node_modules` gives a
  package no identity a change to its contents would move.

  One edge worth naming, since it looks like a bug from outside: removing the
  _last_ dependency a project has leaves nothing to vouch for, which is reported as
  no inventory, and falls open. Correct, and invisible on any tree with more than
  one package left standing.

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

- 505db55: Tell a map covsel cannot use apart from one that is not there, in `covsel
status`.

  `LocalStore.read()` returns `undefined` for a map that is missing, unparseable,
  or recorded under a schema this build does not read, and `computeStatus`
  collapsed all three into `exists: false`. So `status` printed the path of the map
  file and then said it did not exist, and the reason field under `next:` was empty
  because the missing-map branch returned before anything set it. The reader was
  sent to look for a file sitting exactly where covsel had just said it was, with
  no hint that re-recording was the fix.

  Selection was never wrong here: an unusable map falls open to a full run, which
  is what it should do. The collapsing is right for selection — a caller deciding
  what to run must not care _why_ a map cannot be believed — so the distinction is
  drawn beside it rather than inside it.

  - `LocalStore.inspect()` is the diagnostic read: `absent`, `unusable` with the
    reason, or `usable` with the map. `read()` is now defined as "`inspect()`,
    usable or nothing", so the selection path is unchanged and the two cannot come
    to disagree about usability.
  - `mapRejection(value)` in `@covsel/core` says why a stored value is not a usable
    map, or `undefined` when it is one, and `isUsableMap` is defined as
    `mapRejection(value) === undefined`. One place decides usability; the reasons
    are a rendering of that decision rather than a second opinion that could drift
    from it.
  - `StatusResult.exists: boolean` is replaced by `mapState: 'absent' | 'unusable'
| 'usable'` plus an optional `unusableReason`. **This is the breaking part** for
    anything reading `computeStatus` directly: `exists === true` becomes
    `mapState === 'usable'`. The boolean could not express the case that caused the
    bug, which is why it is gone rather than kept alongside.
  - `fullRunReason` takes the map as `unknown`. Its "recorded map is stale or has
    an incompatible schema" branch was unreachable while the parameter was typed as
    a `CoverageMap`, which is exactly the wording a caller holding a rejected map
    needs.
  - `covsel status` prints `exists: yes, but not usable (schema v3, covsel reads v4
-- re-record)`, and gives a reason under `next:` in every case rather than
    falling back to a generic "map cannot be trusted". A rejected map answers there
    in its own words: "no usable map recorded" is what an absent map is called, and
    saying it about a file that is sitting right there is the misreport this fixes.
    The recorded-at, granularity and entry lines are still printed only for a map
    that parsed.
  - `covsel explain` had the same lie in the same words — it printed `(none
recorded)` beside the path of a map it had just rejected. `ExplainResult.mapExists`
    is replaced by the same `mapState`, `noMapReason` carries the rejection, and
    the CLI prints `(not usable)` for a map that is there. **Breaking** in the same
    way: `mapExists === true` becomes `mapState === 'usable'`.

- 6020222: Treat an executed-but-unmappable script as a recording failure, and resolve
  source maps from a sidecar, an inline `data:` URI, over HTTP, or a build
  directory.

  A map entry that records no sources is indistinguishable from a test that
  genuinely covers nothing, and selection reads it the second way. That is
  reachable from a stock bundler setup: `vite build` emits no source map unless
  asked, and `sourcemap: 'hidden'` writes the map while stripping the comment that
  points at it. Recording a suite whose tests reach their code through such a
  build produced entries that existed and credited nothing, so editing the file
  every test executes selected zero tests — not a full run, nothing. `recordMap`
  already refuses to write a partial map because a partial map cannot be trusted;
  the same rule now exists one level down, where a script becomes sources.

  A script that executed and resolves to no source in the repository now fails the
  recording with `UnmappableScriptError`, naming the script, and no map is
  written. Scripts covsel can account for are unaffected: a file in the repository
  is its own source, vendored code under `node_modules` is covered by the lockfile
  sentinel rather than by coverage, and the runtime's own scripts are not the
  project's code. What fails is code built from this repository and handed back to
  the runner — out of a build directory, or over HTTP — with no way to trace it
  home.

  The discovery half ships with it. `SourceMapResolver` finds a script's map
  through a `sourceMappingURL` comment naming a sidecar, the same comment carrying
  the map inline as a `data:` URI, the conventional `<script>.map` neighbour when
  a build stripped the comment, an HTTP fetch for scripts a browser loaded from a
  dev server, and `sourceMaps.buildDirs`, which maps a serve-time URL prefix onto
  the directory holding the built assets. Only the `sources` list is read: until
  executed ranges are projected through the mappings, a mapped script credits
  every source it was built from, which over-selects rather than under-selects.

  A source is located or reported, never guessed at. A map read from disk places
  its sources exactly, relative to itself; one fetched over HTTP has no such
  anchor, so each source is confirmed against the text the build published in
  `sourcesContent` before being credited — a served path that merely matches a
  same-named file would otherwise credit the wrong file and lose every change to
  the right one. A source that cannot be confirmed, or that should be in the
  repository but is not where the map says, fails the recording alongside a map
  with no sources at all: a partly resolved map used to count as a success, which
  put the sources it could not find nowhere.

  Loading is bounded, because a `sourceMappingURL` is content covsel did not
  write: a map is fetched only from the origin that served the script, with a
  timeout, a size ceiling, and no redirects, and a served path may not walk out of
  the build directory it was mapped onto.

  Scripts that will never be mappable — a third-party widget on the page under
  test — can be accepted with `sourceMaps.allowUnmappable`, matched strictly so a
  glob cannot quietly cover more than it says. Each entry is a hole in the
  recording, so `covsel record` names the scripts it let through every time it
  lets one through.

- 538db8f: Always run a test whose entry credits no source.

  An entry with an empty file list read to the selector exactly like a test that
  covers nothing: no changed path could match it, so nothing ever selected it.
  covsel already refuses to read "the map says nothing about this test" as "this
  test covers nothing" — a discovered test with no entry always runs — and an
  entry crediting nothing is the same claim in a different shape. It was read the
  other way, and the test silently never ran again.

  The situation is not exotic. A test that drives its subject in a child process,
  a worker, or a browser records nothing at all under a recorder whose coverage
  mechanism does not reach there. That blind spot belongs to the test rather than
  to the recorder, so `observed` — one scope for the whole run — cannot express it
  and the empty entry falls straight through. Three of covsel's own test files are
  in exactly that position under the Vitest adapter.

  So selection now treats an entry crediting no source as unknown coverage: its
  test file is selected on every run, whole, including when other units of the
  same file did record coverage. A recorder that could not see one unit of a file
  has not earned trust in what it recorded for the units beside it, and a test
  that genuinely covers nothing running when it need not is the cheap way to be
  wrong.

  `covsel merge` carries the same doubt across a shard merge. A test one shard
  credits with no source keeps crediting nothing rather than inheriting what
  another shard saw: an empty entry is a shard reporting it could not see where
  the test ran, and unioning it away produced a merged entry claiming something
  neither shard claimed. Covered blocks and package lists already degraded to
  unknown this way when either shard lacked them; covered files now do too.

  Recording is not refused over it — a test that only asserts on constants
  legitimately covers nothing — but it is no longer silent. `covsel record` names
  each test file that recorded no source as it records it and again in its
  summary, `covsel status` counts the entries separately from `entries:`, and
  `covsel explain <test>` says the file is selected on every run, distinguishing
  it from a test the map does not record at all.

- 76df431: `@covsel/core` gains `packageNameFromRelPath` and `isVendoredRelPath`: which
  package a vendored file belongs to, and whether a path is vendored at all.

  The rule is the one Node resolves by — the innermost enclosing `node_modules`
  names the package — so a dependency that bundles its own copy of another is
  credited to the inner copy, which is what code inside it would actually load.
  That same rule reads pnpm's virtual store with no knowledge of pnpm:
  `node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js` has its real
  `node_modules` last, so the store's flattened, version-suffixed directory name
  is never mistaken for a package name. Node reports realpaths, so that is the
  shape every pnpm project's coverage arrives in.

  Decided from path segments alone, with no filesystem access. Attribution runs
  once per executed script, hundreds of thousands of times over a suite, and
  reading the enclosing `package.json` instead would cost some fifty times as much
  and make a cache mandatory.

  The two questions stay separate on purpose. A `node_modules` path covsel cannot
  name a package for — the package managers' own `.bin`, `.pnpm`, and
  `.package-lock.json` bookkeeping — is still vendored, and reading "no package
  name" as "first-party code" is how vendored code would stop falling open.

  No selection behaviour changes: nothing records or reads package names yet. The
  mapper's own vendored-code check now goes through `isVendoredRelPath` so the two
  definitions cannot drift apart.

- 1281329: Fail before running anything when the Vitest adapter's coverage provider is
  missing.

  Vitest runs a suite quite happily without `@vitest/coverage-v8` and simply
  writes no report, so the problem surfaced once per test file _after_ the whole
  suite had been paid for — and what it needs is one install. The adapter now
  checks up front and names the command that fixes it.

  `@covsel/core` gains `isPackageInstalled(cwd, name)`. It walks the
  `node_modules` chain from `cwd` upward by hand rather than using
  `require.resolve.paths`, which mixes in the _calling_ module's own chain: asked
  from inside covsel, that reports covsel's dependencies as the project's, so a
  globally installed CLI would answer about the wrong tree. Presence is decided by
  the package directory rather than by resolving an entry point, so a package
  declaring only an `import` condition in its `exports` map still reads as
  installed.

  The CLI reports an adapter's refusal to build a recorder as a message with the
  fix in it rather than an unhandled stack trace, for `record` and for `watch`'s
  re-record.

### Patch Changes

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

- f068792: Fix a map recorded from a dirty working tree being stamped with `HEAD`, which
  could skip a test.

  `assembleMap` stamped every map with `git rev-parse HEAD`, which knows nothing
  about uncommitted work — so a map recorded mid-edit described the tree as edited
  while claiming to describe `HEAD`. Selection treats a recorded commit as exact, so
  once the tree returned to `HEAD` (a revert, a stash, a fresh clone at that commit,
  or CI restoring the map onto it) the diff from the stamped commit was empty and the
  map was fully trusted for a tree it never described. Coverage the edited tree did
  not execute was absent from a map that `covsel status` reported as healthy, and
  both guards that normally catch a bad map passed: the commit genuinely existed and
  genuinely matched the tree, and the changed file was inside the observed scope.

  A map covsel cannot attribute to a commit now records none, and the existing
  fall-open path takes over with the reason it already had — _"map records no commit,
  so changes since it was recorded are unknown"_. `covsel record` says so when it
  writes the map, rather than leaving it to be discovered when selection later
  declines to narrow, and `RecordResult` carries `unanchored` for embedders.

  The tree is sampled before the suite runs rather than after, because the question
  is what tree the recording was taken against. A suite that writes into the
  repository — a snapshot on first run, a report, a log — is dirty by the end through
  no fault of its sources, and sampling then would leave such a project permanently
  unanchored and always falling open.

  The cost is deliberate: recording with uncommitted work now yields full runs until
  you commit and re-record. That is what covsel actually knows about such a map. CI
  is unaffected, since it records on a clean checkout.

- 181135e: Never name a test file the checkout does not have.

  A map entry outlives the test file it names. Delete a test, change a source it
  covered, and the entry is still there crediting that source — so the selection
  named a path that is no longer in the suite.

  Nothing was skipped by it, which is why it went unnoticed. What it did was hand
  the decision to the runner, and the runners disagree: vitest ignores a path it
  cannot find and quietly runs one fewer file than the selection named, while a
  runner that treats an unknown path as an error turns the whole run red over a
  stale entry. Neither is an answer worth leaving to chance, and the first is the
  worse of the two — a selection reporting six files and running five.

  Units are now dropped when discovery does not find their test file, which is the
  rule already applied to entries crediting no source at all. Drawn from discovery
  rather than from the diff, because a file can leave the suite without any diff
  saying so: renamed, moved out of `testGlobs`, or excluded by a config change.

  `status` gained `staleEntryCount`, the number of entries naming a test the suite
  no longer has, printed only when there are any. Selection drops them silently and
  correctly, which is exactly why it is worth reporting: nothing else in that report
  would say the map has drifted from the _suite_ rather than from the sources, and
  a map still describing tests the project removed is a map due to be recorded
  again.

- 7e034a9: Fix an empty map selecting no tests and exiting 0.

  Three separate holes, all reachable from one mundane cause — `testGlobs` that do
  not match the project's layout. The default globs look for `*.test.js`, and
  express, like many Mocha and node:test projects, names its tests `test/*.js`.

  `covsel record` treated "no test files discovered" as success: it wrote a
  syntactically valid map with `"entries": []` and exited 0. Recording now fails,
  writes no map, and names both the globs it tried and the directory it searched.
  There is no repository for which an empty map is the right answer.

  `FailOpenPolicy` now forces a full run for a map with no entries, and
  `fullRunReason` says why. Such a map measured nothing, so its silence about a
  changed file is not a measurement — reading it as "no test covers this" is what
  turned a mismatched glob into a green CI job that ran no tests.

  Selecting when discovery finds no test files falls open to a full run instead of
  returning an empty selection. A full run hands the runner its own command
  unfiltered, so the runner's own discovery finds the tests covsel's globs missed —
  where before, `covsel run` executed zero tests and exited 0.

  `covsel status` reports the discovered test count, and reports an entry-less map or
  a project with no discovered tests as a full run with the reason, rather than as
  `next: select`. `StatusResult` gains `discoveredTestCount`, and `RecordResult`
  gains `error` for a failure that belongs to the run rather than to a test file.

  Note for anyone with fixtures: a `CoverageMap` with `entries: []` is now always a
  full run, so a test using one as a stand-in for "some map" needs an entry to
  exercise anything downstream of that check.

- 859ff72: The installed-package inventory is now built from what the project can reach,
  not from what is sitting in `node_modules`.

  pnpm never prunes its virtual store, so a dependency removed from the project
  stays on disk indefinitely and was still being reported as installed. That made
  a removal look like no change at all — the recorded inventory and the current
  tree agreed — which is the reading that would skip the very tests whose imports
  the removal just broke. It also put a package in the inventory that no entry
  could ever credit, since nothing links to an orphan and nothing can execute it.

  The store is a graph to be followed rather than a directory to be listed. pnpm
  keeps each resolved package in its own entry, whose `node_modules` holds the
  package alongside one symlink per dependency:

  ```
  node_modules/.pnpm/is-odd@3.0.1/node_modules/
    is-odd                                       <- the package
    is-number -> ../../is-number@6.0.0/node_modules/is-number
  ```

  So the walk starts from what the project depends on and follows those links out
  of each store entry. Transitive dependencies are still found — `is-number`
  through `is-odd` — and orphans are not, because nothing points at them.

  Verified against real `pnpm install`: removing one of two dependencies now
  removes it from the inventory while its store entry remains on disk, and the
  transitive dependency of the surviving one is still recorded.
