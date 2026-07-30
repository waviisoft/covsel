---
'@covsel/core': minor
---

A recording now captures which installed packages each test executed, and what
was installed at the time. Nothing selects on it yet — every lockfile change is
still the full run it is today — but both halves are on disk and inspectable.

`MapEntry` gains `packages`, the names of the packages a test ran code in.
`CoverageMap` gains `dependencies`: the package manager, its install marker and
that marker's hash, and an inventory of every installed package with the
versions it was resolved to. The inventory is what makes silence readable. A
changed package inside it that no entry mentions was watched and never ran, so
nothing need be selected for it; a changed package absent from it is one the map
never had an opinion about, and falls open. Without it the two are
indistinguishable and everything falls open.

The marker is the freshness proof, and it is not optional. A lockfile pulled
without an install would leave the tree looking unchanged, and "nothing changed"
computed against a stale install is the answer that skips tests. pnpm writes a
byte-identical copy of its lockfile into the store, npm a hidden lockfile, and
yarn its install state; bun and yarn's PnP linker write nothing usable, so a
project on either records no `dependencies` and keeps falling open. So does a
tree carrying two managers' markers, where which install it reflects is
unknowable.

`Recorder` gains `observesPackages`, a claim `observes` cannot express — `**`
already matches every `node_modules` path, so no scope distinguishes a recorder
that watches vendored code from one that never sees it. Only the generic
`NODE_V8_COVERAGE` recorder declares it: a runner's own coverage provider drops
`node_modules` before covsel sees anything, and a per-test window opened in a
`beforeEach` misses whatever ran while the module graph was evaluating.
Recording refuses a recorder whose units and declaration disagree in either
direction, so packages are present on every entry of a map or on none.

Packages a recorder could never observe stay out of the inventory. A platform
binary whose whole payload is an executable, or whose only entry point is a
`.node` addon, can never be credited to a test — and a package in the inventory
that no entry credits reads as "ran nowhere", which is the reading that skips
tests. A JS wrapper around a native addon does not qualify: the wrapper
executes, and covsel sees it.

`mergeMaps` intersects inventories across shards, the analogue of `agreedScope`
and safe for the same reason — a smaller inventory falls open more. Shards whose
markers disagree installed different trees and yield no `dependencies` at all,
as does any shard silent about packages.

`MAP_SCHEMA_VERSION` is 3. Every stored map is invalidated, which forces one
full run with a log line saying so; recording again restores selection.
