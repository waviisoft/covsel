---
'@covsel/core': minor
---

`@covsel/core` gains `packageNameFromRelPath` and `isVendoredRelPath`: which
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
