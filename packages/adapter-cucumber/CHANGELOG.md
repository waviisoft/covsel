# @covsel/adapter-cucumber

## 0.1.1

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

- 1281329: Declare the runner each adapter drives as a peer dependency. An adapter shells
  out to its runner and reads the coverage that run produces, so the runner is a
  hard requirement it was asserting only in prose: `@covsel/adapter-vitest` needs
  `vitest` and `@vitest/coverage-v8`, `@covsel/adapter-jest` needs `jest`, and
  `@covsel/adapter-cucumber` needs `@cucumber/cucumber`.

  Declaring them makes npm install what is missing and pnpm and yarn say what is,
  so the requirement reaches someone who installs an adapter by hand rather than
  through `covsel init`. The ranges are deliberately open: the adapters are
  written against each runner's stable coverage output rather than a version
  floor anyone has tested, and a floor asserted without testing would be a guess.

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

### Patch Changes

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

- 049ee96: Carry the mapper's configuration into the per-test recorders.

  The node:test and cucumber adapters map coverage inside the runner they spawn, and each was handing that runner three configuration fields it had picked by hand. `sourceMaps` was not among them, so `allowUnmappable`, `buildDirs`, and `http` were inert for both: a project whose tests reach their code through a build with no source map could accept that gap in its config, watch the generic wrap honor it, and still find recording impossible under either per-test adapter. The failure direction was safe — recording refuses rather than crediting nothing — but it was total, and nothing said why, because the setting had simply never arrived.

  Both recorders now carry exactly what the mapper reads, and both report the scripts it let through, so `covsel record` names accepted gaps whichever adapter produced the map. `@covsel/core` exports the `MapperConfig` type and `toMapperConfig` to make that one narrowing rather than one per adapter, and `toMapperConfig` names every key under a type that requires all of them — including optional ones, which is how `sourceMaps` was dropped in the first place. Adding a field to what the mapper reads now stops the carriers compiling.

  Recording also drops what a failed file let through unmapped before moving to the next one. A recorder that accumulates across files would otherwise carry it forward, and the next file's progress line would name a script that file never executed.

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
