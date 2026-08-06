# @covsel/adapter-mocha

## 0.1.0

### Minor Changes

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
