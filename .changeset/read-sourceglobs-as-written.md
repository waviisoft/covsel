---
'@covsel/core': minor
---

Read `sourceGlobs` as the paths they name, not as basenames anywhere in the tree.

`makeMatcher` gives a slash-less glob a second chance against a path's basename
at any depth, so that a sentinel like `package.json` also catches a workspace's
own manifest. That reasoning holds for `sentinels`, where matching more runs more
tests. It did not hold for `sourceGlobs`, which shared the same matcher.

A project writing `sourceGlobs: ["index.js"]` to mean _the package entry point_
silently got every `index.js` in the repository — examples, fixtures, scripts —
recorded as covered source. Measured on `expressjs/express` with
`sourceGlobs: ["lib/**/*.js", "index.js"]`: a map reporting **29 covered sources
for a library that has 7**, the other 22 being example apps that ship to nobody.

No test was ever skipped by it — the effect is over-selection, which is the safe
direction. What it cost was the map as a diagnostic and part of the saving:
`covsel status` reporting 29 sources with no way to see where they came from, and
editing an example app selecting tests that cannot depend on it.

`sourceGlobs` are now matched literally, repo-relative. Write `"**/index.js"` for
the recursive reading — it already worked and says what it means.

`testGlobs` keeps the widening, and the asymmetry is the point: a source glob
matching too much costs precision, while a test glob matching too little leaves
the tests it missed unrun. `"*.test.js"` meaning "only at the root" would be a
skipped test rather than a wide map.

**This changes what an existing config means** for any project whose
`sourceGlobs` contain a slash-less pattern that was matching nested files. Their
next recording will credit fewer sources; a map recorded before the upgrade keeps
describing what it described, since the config value itself has not moved.
