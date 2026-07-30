---
'@covsel/core': minor
'@covsel/adapter-vitest': minor
'covsel': minor
---

Fail before running anything when the Vitest adapter's coverage provider is
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
