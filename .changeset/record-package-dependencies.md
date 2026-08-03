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

A package reaches a test two ways and both are counted: it executes as its own
script under `node_modules`, which is a path question, or a bundler inlined it
into built output and nothing under `node_modules` ever runs, in which case only
the built script's source map names it. Reading the first and not the second
would leave the package in the inventory with no entry crediting it.

For the same reason, a package whose identity does not survive resolution stays
out. The walk sees `node_modules/<name>`; V8 reports the realpath of whatever
executed. A linked workspace package resolves to `packages/<name>` and its
coverage arrives as first-party source; a package linked from outside the
repository resolves out of the tree entirely; a pnpm aliased install resolves to
the store entry for the package it aliases. No entry can name any of them, so
each is dropped and falls open. Ordinary pnpm installs are unaffected, since a
store path still reads as the package it holds. The walk also dedupes by
realpath, without which a monorepo whose workspace packages link to each other
walks a cycle rather than a tree.

`Recorder` gains `observesPackages`, a claim `observes` cannot express — `**`
already matches every `node_modules` path, so no scope distinguishes a recorder
that watches vendored code from one that never sees it. Only a recorder reading
a raw `NODE_V8_COVERAGE` dump is in a position to declare it: a runner's own
coverage provider drops `node_modules` before covsel sees anything, and a
per-test window opened in a `beforeEach` misses whatever ran while the module
graph was evaluating.

Recording **fails** a declaring recorder whose unit omits `packages`, since
there is no safe way to guess what it ran. The reverse is only declined: a unit
reporting packages its recorder has not claimed to watch has them dropped, and
the map keeps none. Adapter authors who wrap another recorder and forward its
units under their own declaration lose the feature rather than the recording.

Packages a recorder could never observe stay out of the inventory. A platform
binary whose whole payload is an executable, or whose only entry point is a
`.node` addon, can never be credited to a test — and a package in the inventory
that no entry credits reads as "ran nowhere", which is the reading that skips
tests. So does a types package: `"main": ""` is how DefinitelyTyped says there
is nothing to run, and an `exports` map offering only a `types` condition names
a declaration file no runtime executes. A JS wrapper around a native addon does
qualify and stays: the wrapper executes, and covsel sees it.

`mergeMaps` intersects inventories across shards, the analogue of `agreedScope`
and safe for the same reason — a smaller inventory falls open more. Shards whose
markers disagree installed different trees and yield no `dependencies` at all,
as does any shard silent about packages.

`MAP_SCHEMA_VERSION` is 3. Every stored map is invalidated, which forces one
full run with a log line saying so; recording again restores selection.
