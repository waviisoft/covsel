---
'@covsel/core': minor
'@covsel/conformance': minor
'@covsel/adapter-cucumber': minor
'@covsel/adapter-generic': minor
'@covsel/adapter-jest': minor
'@covsel/adapter-node-test': minor
'@covsel/adapter-vitest': minor
'covsel': minor
---

Move the adapter capability contract into `@covsel/core`, so an adapter is one
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
