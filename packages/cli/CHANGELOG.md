# covsel

## 0.2.0

### Minor Changes

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

- Updated dependencies [2c18c09]
- Updated dependencies [8f3646b]
- Updated dependencies [07f570a]
- Updated dependencies [3edd43b]
  - @covsel/core@0.2.0

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

- decf431: Make `covsel init` interactive by definition, and put `--no-install` in the plan
  rather than behind it.

  `init` writes files and installs packages, so it should do nothing without an
  answer — and silence is not one. A run with no terminal previously proceeded and
  installed, on the reasoning that running the command is itself the intent. That
  is not good enough for something that adds dependencies to a project: in CI or
  under a coding agent there is nobody to ask, and installing anyway assumes
  consent that was never given. `init` now prints the plan, changes nothing, and
  exits non-zero unless `--auto-approve` says otherwise.

  `--auto-approve` replaces `-y` / `--yes`. The name is the point: this is not
  "answer the prompt", it is "authorise an unattended run to change the project".

  `--no-install` now describes a different plan rather than a quieter one. It
  previously suppressed the install silently, so the plan being agreed to never
  mentioned the adapter the project still needed, and nothing mentioned it
  afterwards either. The packages are now listed under `skip` with the command
  that installs them, and named again once the config is written.

  Declining is unchanged and stays that way: nothing is written and nothing is
  installed. Declining the plan and asking for a plan without an install are
  different answers, and `--no-install` is how you say the second.

  The two refusals exit differently, deliberately. Declining exits 0 — you were
  asked and you answered, and the command did what you told it to. An unattended
  run with no approval exits non-zero, because nothing asked and nothing answered:
  a `covsel init && covsel record` chain must not carry on as though the project
  were configured. Mind that a declined interactive run does let such a chain
  continue; if you script around `init`, check for the config rather than the exit
  code.

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

- 51e4789: Add `@covsel/adapter-jest`, so `covsel record|affected|run --adapter jest` works
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
