---
'@covsel/core': patch
---

Say what a full-run reason measured the change against.

`sentinel changed: covsel.config.js` is about two states, and it named one. The
reader has to supply the other, and the obvious guess — _changed in my branch_ —
is wrong exactly when the message matters most. The window is the commit the map
records against the working tree, so on a pull request it includes everything
merged to the default branch since the recording. A branch that never touched
`covsel.config.js` gets told `covsel.config.js` changed, and the author's first
move is to search a diff that does not contain it.

The three reasons that name a changed file now end with the window they were
measured over:

```diff
-sentinel changed: pnpm-lock.yaml
+sentinel changed: pnpm-lock.yaml (measured since the map was recorded at a1b2c3d4e5f6)
```

With an explicit `--since`, no recording happened at that ref, so the sentence
changes to match: `(measured since origin/main)`.

The qualifier is appended rather than woven into the phrase. Weaving it splits
what a reader and a `grep` both key on — `sentinel changed: pnpm-lock.yaml`
becoming `sentinel changed since …: pnpm-lock.yaml` — which moves the answer to
make room for the note about how the question was asked. Trailing, the answer
stays where it has always been.

The reasons that describe the map itself (`no usable map recorded`, an
incompatible schema, a map with no entries) are unchanged, since none of them is
about a file having moved. Neither is the config-field comparison, which already
names its own two states.
