---
'@covsel/core': patch
---

The installed-package inventory is now built from what the project can reach,
not from what is sitting in `node_modules`.

pnpm never prunes its virtual store, so a dependency removed from the project
stays on disk indefinitely and was still being reported as installed. That made
a removal look like no change at all — the recorded inventory and the current
tree agreed — which is the reading that would skip the very tests whose imports
the removal just broke. It also put a package in the inventory that no entry
could ever credit, since nothing links to an orphan and nothing can execute it.

The store is a graph to be followed rather than a directory to be listed. pnpm
keeps each resolved package in its own entry, whose `node_modules` holds the
package alongside one symlink per dependency:

```
node_modules/.pnpm/is-odd@3.0.1/node_modules/
  is-odd                                       <- the package
  is-number -> ../../is-number@6.0.0/node_modules/is-number
```

So the walk starts from what the project depends on and follows those links out
of each store entry. Transitive dependencies are still found — `is-number`
through `is-odd` — and orphans are not, because nothing points at them.

Verified against real `pnpm install`: removing one of two dependencies now
removes it from the inventory while its store entry remains on disk, and the
transitive dependency of the surviving one is still recorded.
