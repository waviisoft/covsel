---
'@covsel/core': minor
'covsel': minor
---

Judge a config change by what it changed, not by the file changing.

A map is meaningful only under the configuration it was recorded with, which is
a statement about that configuration's values. covsel read it as a statement
about the file: any diff touching `covsel.json` or `covsel.config.js` forced a
full run, so rewording a comment in one cost the whole suite while the map went
on meaning exactly what it meant.

The map now records a digest of each value it was recorded under, and selection
compares the values in force against them. That is the sharper question in both
directions: a reworded comment, a reformatted array or a moved key narrows as
usual, while a value that moved without the diff showing it — a config computed
from the environment, or one changed and changed back across the recorded commit
— falls open where it used to slip through. `covsel status` and `covsel affected`
name the fields that differ instead of naming the file.

Digests rather than values because a map travels: it is published to an archive
other machines fetch, and `sourceMaps.buildDirs` holds paths that can be absolute
and URL prefixes that can name an internal host. A value covsel cannot serialise
faithfully — a `RegExp`, a `Map`, a function, all of which a `.js` config can
hold — reads as changed rather than as equal to another it also cannot read.

One field is excluded: `store` says where the map is kept, not what it says.
Everything else is compared, including fields added later. `alwaysRun` and
`sentinels` are compared even though both are read from the configuration in
force, because the commit that _removes_ one is the case that matters — it drops
a file from `sentinels` and edits that same file, and the diff giving up the
protection would otherwise be the one that goes unprotected.

The comparison runs on the config file's own account, ahead of `sentinels` and
without consulting it. A project that also lists the file in `sentinels` keeps
the unconditional full run that declaration asks for: covsel's defaults name no
config file, so listing one is deliberate, and the project may have a reason
covsel cannot see from the values it reads. Dropping it from the list gives the
narrowing and gives up nothing.

Falling open is preserved wherever the comparison cannot be made: a map recorded
before this existed carries no configuration and keeps forcing a full run on any
config-file change, as does a map merged from shards that disagreed about the
configuration they recorded under, and one whose record of it is unreadable —
which answers as absence rather than as a stack trace out of `affected`,
`status` or `merge`.

`covsel status` and `covsel explain` now resolve configuration through the
adapter the way `record`, `affected`, `run` and `watch` do. Without it, a project
on an adapter that supplies `defaultTestGlobs` (Mocha, Cucumber) and sets no
`testGlobs` of its own would have `status` reporting a configuration change on
every run while `run` narrowed — the two commands answering the same question
differently.

`covsel explain` reports the distinction rather than promising a full run it will
not take: `forcesFullRun` is now `{ always, why }`, where a sentinel is always
and a config file judged by its values is not.

Two API signatures widen, which an external caller passing a config literal will
see at compile time: `FailOpenPolicy`'s constructor and `fullRunReason` take a
full `CovselConfig` rather than a `Pick` of it, since the comparison reads every
field a map records.
