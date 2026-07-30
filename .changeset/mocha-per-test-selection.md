---
'@covsel/adapter-mocha': minor
'@covsel/adapter-node-test': patch
'@covsel/adapter-cucumber': patch
'@covsel/core': minor
---

Add per-test selection for Mocha, and prove the file-level path it builds on.

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
