---
'@covsel/core': minor
---

Sentinel the files that decide how a lockfile becomes a `node_modules`, and stop
vouching for a package whose layout cannot say which code is there.

Two gaps found by independent review of the dependency-inventory work, both
fail-closed, and both between the inventory and any use of it.

**`.npmrc` and friends are now default sentinels.** A lockfile says which
packages are installed; these say where they are put and what resolves to them,
and the two are independent. pnpm's `hoist-pattern` fills
`node_modules/.pnpm/node_modules/`, the fallback that resolves undeclared
("phantom") imports for everything in the store. Narrowing it removes that
directory and an import that worked becomes `MODULE_NOT_FOUND` — with the
lockfile unmoved, no sentinel firing, and the inventory none the wiser, since it
never enters a dot-directory. A selection was computed against a resolution that
no longer held. `.pnpmfile.cjs` is worse: it rewrites manifests at install time,
so it can change what any package depends on without appearing anywhere else.
`.npmrc`, `.pnpmfile.cjs`, `.yarnrc.yml`, `.yarnrc`, and `bunfig.toml` join the
lockfiles in `DEFAULT_CONFIG.sentinels`. A project holding one of these files
and setting no `sentinels` of its own will see a full run where it previously saw
a selection, which is the direction that cannot skip a test. Settings made
outside the repository — `~/.npmrc`, `NPM_CONFIG_*` — remain beyond what any
sentinel can see.

**A package outside a store is left out of the inventory.** Its identity was the
path plus the version its manifest declares, and a version is not a content
signal: `pnpm patch` rewrites the files and leaves the version alone. Under
`node-linker=hoisted` every package is in that shape, the freshness proof still
passes, and a patched dependency would read as "installed and never ran" — the
inference that skips the tests running the patched code. Such a package now falls
open, exactly as one whose store entry names a `file:` directory already did.

Hashing the files would give those layouts a real identity, and was measured
rather than assumed: 700 packages of this repository are 281 MB across ~25,000
files and take 14 seconds to hash. That is not a price to add to every recording,
and no cheaper signal is honest — sizes and timestamps both report "unchanged"
for edits that are not.

The cost is worth stating plainly. A project on `node-linker=hoisted` now records
no inventory, so every dependency change falls open to the lockfile sentinel,
which is what covsel does today for every project. npm and yarn trees are the
same shape; their inventories were already unusable for want of a freshness
proof, but this is a second thing they need before they can select, rather than a
detail of the first. A default pnpm tree is unaffected — measured on this
repository, all 1,367 edges across 611 packages come from store entries and not
one reaches the fallback.

An inventory that ends up vouching for nothing is now reported as no inventory at
all. Both have to fall open, but they are not equally hard to get wrong: a
missing `dependencies` field is what every map recorded before that field existed
presents, so no consumer can overlook it, while an inventory that is present and
empty is a second rule — and forgetting it means diffing `{}` against `{}`,
finding nothing changed, and skipping the suite.
