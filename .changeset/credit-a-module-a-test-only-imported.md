---
'@covsel/core': minor
---

Credit a module a test imported but never called into, without re-selecting on
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
