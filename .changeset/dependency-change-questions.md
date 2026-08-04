---
'@covsel/core': minor
---

`@covsel/core` gains the three answers a dependency change turns on, ahead of
anything reading them: `treeIsProvablyCurrent`, `changedPackages`, and
`dependencyOnlyManifestChange`.

`treeIsProvablyCurrent` asks whether the installed tree really reflects the
lockfile as it stands. A lockfile pulled without an install leaves the old
packages in place, so comparing inventories would report nothing changed and
skip the tests for every package that did move. pnpm copies its lockfile into
the store on every install, so the two agreeing is a proof rather than a
heuristic — and it is the only sound check available, since "the tree shows no
difference" proves nothing on its own when a tree stale for one reason can still
differ for another. npm and yarn write their own install state rather than a
copy, so the question cannot be asked of them yet. It reports why it failed, not
merely that it did.

`changedPackages` names the packages installed at a different set of versions
than before, counting a removal and an appearance as changes. It is deliberately
weaker than "the code changed", and says so: an inventory records one version set
per name for the whole repository, so `pnpm patch` rewriting a package's source
without moving its version, or one workspace importer swapping between two
versions that both remain installed, compare equal. Callers may not read an empty
result as "nothing is affected".

`dependencyOnlyManifestChange` asks whether a `package.json` edit stayed inside
the four dependency blocks. It is a sentinel because nearly anything in it
changes what a test does, and the test is an allowlist rather than a denylist, so
the next field npm invents is refused rather than admitted silently. `overrides`,
`resolutions`, `pnpm.overrides`, and `peerDependenciesMeta` are all outside it:
they decide what a specifier resolves to rather than what is asked for. A
manifest that git reports as changed but which parses identically keeps the full
run, since "nothing is known to have moved" is not "nothing moved".

Nothing calls any of this yet, so no selection behaviour changes.
