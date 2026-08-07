# @covsel/adapter-generic

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
