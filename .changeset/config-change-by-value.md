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

The map now records the configuration it was recorded under, and selection
compares the values in force against it. That is the sharper question in both
directions: a reworded comment, a reformatted array or a moved key narrows as
usual, while a value that moved without the diff showing it — a config computed
from the environment, or one changed and changed back across the recorded commit
— falls open where it used to slip through. `covsel status` and `covsel affected`
name the fields that differ instead of naming the file.

Four fields are excluded, because a change to one cannot leave the map meaning
something other than what selection reads from it: `alwaysRun` and `sentinels`
are applied from the configuration in force on every run, `store` says where the
map is kept rather than what it says, and `adapter` names the recorder, whose
every consequence for selection is written into the map by the recording itself.
Everything else is compared, including fields added later.

The comparison runs on the config file's own account, ahead of `sentinels` and
without consulting it. A project that also lists the file in `sentinels` keeps
the unconditional full run that declaration asks for: covsel's defaults name no
config file, so listing one is deliberate, and the project may have a reason
covsel cannot see from the values it reads. Dropping it from the list gives the
narrowing and gives up nothing.

Falling open is preserved wherever the comparison cannot be made: a map recorded
before this existed carries no configuration and keeps forcing a full run on any
config-file change, as does a map merged from shards that disagreed about the
configuration they recorded under.

`covsel explain` reports the distinction rather than promising a full run it will
not take: `forcesFullRun` is now `{ always, why }`, where a sentinel is always
and a config file is not.
