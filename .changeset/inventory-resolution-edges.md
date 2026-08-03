---
'@covsel/core': minor
---

The installed-package inventory now records **resolution edges** rather than
versions, and `MAP_SCHEMA_VERSION` is 5.

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

`changedPackages` is unchanged; it compares the same shape it always did.
