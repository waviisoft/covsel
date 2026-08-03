---
'@covsel/core': minor
---

Exclude a nested function's body from its enclosing function's block hash, and
bump `MAP_SCHEMA_VERSION` to 4.

`extractBlocks` canonicalized the module block with every outermost function body
blanked out, so an edit inside a function did not change the module's hash. It
did not do the same one level down: a function block was canonicalized with an
empty exclusion list, so **a function's hash included its nested functions'
bodies verbatim**. Editing an inner function changed every enclosing function's
hash, and any test that executed an enclosing function was selected.

That is over-selection — safe, and invisible unless you look for it — but it is
where block precision goes to die in component frameworks. React, Vue, and
Svelte all put handlers, effects, and callbacks _inside_ a component function, so
every edit to any of them selected every test that rendered the component: block
granularity silently collapsed to component granularity, for every runner that
records blocks. Measured on a component with two specs, one clicking its button
and one not, editing the click handler selected both. It now selects the one that
clicked.

A block's hash now covers its own signature and its own statements, with the
bodies of the functions nested inside it blanked the way the module block already
blanks outermost ones — the same rule at every depth rather than only at the top.
Nothing else moves: the blocks emitted, their names, their order, and their
coverage probes are unchanged, and hashes remain stable across reformatting.

**A nested function's signature stays with its parent.** Only the body is the
child's. The parent evaluates the function expression, so the parameter list and
the position among the parent's statements are the parent's own code, and
changing them selects the parent's tests as well as the child's. It is the same
treatment the module block already gives top-level functions, and it is the
fail-open direction: the alternative moves code out of every enclosing block
without moving it into any other.

**Migration: this is a breaking change to persisted state.** Every block hash
changes, so every stored map recorded at `block` granularity is invalidated at
once. `MAP_SCHEMA_VERSION` goes from 3 to 4, which means covsel rejects those
maps outright and falls open to a full run rather than selecting against hashes
that can no longer match anything. Re-record to get selection back:

```bash
covsel record -- <your test command>
```

Until then `covsel status` reports the map as present and unusable, naming the
schema it found and the one this build reads.
