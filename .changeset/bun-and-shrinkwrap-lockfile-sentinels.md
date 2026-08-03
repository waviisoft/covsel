---
'@covsel/core': minor
---

Make every lockfile covsel recognises a default sentinel: `bun.lock`,
`bun.lockb`, and `npm-shrinkwrap.json` join `pnpm-lock.yaml`, `yarn.lock`, and
`package-lock.json`, so a dependency change in a bun project forces a full run
like it always did in a pnpm one.

A dependency change is the one change covsel cannot see any other way. Vendored
code under `node_modules` is deliberately outside what a recording maps, so
nothing in the map moves when a dependency version does, and the lockfile is the
only place the change shows up at all. A lockfile that is not a sentinel is a
`bun update`, or a lockfile-maintenance pull request, selecting against a map
recorded before the bump — and skipping the test the new version breaks. A
project that also edited `package.json` in the same commit was saved by that
sentinel; the exposure was a lockfile-only diff, which is the ordinary shape of
re-resolving a floating range.

The names came in threes rather than ones: bun writes the binary `bun.lockb` in
older versions and the text `bun.lock` in newer ones, so covering only the name
you have heard of leaves the other half of bun projects exposed, and npm honours
`npm-shrinkwrap.json` over `package-lock.json` when a project publishes one.

`@covsel/core` gains `LOCKFILES` and `LOCKFILE_NAMES`, the single list the
sentinel defaults and `covsel init`'s package-manager detection now both read.
Those two had drifted, which is how this happened: `bun.lockb` was already good
enough to pick an install command with, but not good enough to invalidate a map.
Detection gains the names it was missing along the way, so a bun project holding
only the text lockfile no longer reads as npm. It answers as it always did for
every tree it already recognised, including one carrying two managers'
lockfiles: `npm-shrinkwrap.json` is checked last, after bun, because a tree
holding only a shrinkwrap resolves to npm by the fallback regardless, and
checking it earlier would have moved a bun project that once published one to
npm for nothing.

Setting `sentinels` still replaces the defaults wholesale, so a project that has
narrowed the list keeps whatever lockfile it wants covered.
