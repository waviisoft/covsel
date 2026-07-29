---
'@covsel/core': minor
---

Force a full run when covsel's own config file changes.

A map is only meaningful under the configuration it was recorded with, and
nothing was checking that. Narrowing `sourceGlobs` is the sharpest case:
changes outside the new globs stop counting as changes at all, while the map's
recorded `observed` scope still covers them from the wider recording — so
neither the sentinel list nor the observed-scope check notices, and the tests
covering those files are quietly skipped. That is the one outcome covsel exists
to prevent.

The check runs ahead of the project's own `sentinels` rather than being added to
their defaults, because that list replaces wholesale when a project sets one: a
project that tightens its sentinels should not thereby lose the protection over
the meaning of its own map. `covsel status` and `covsel affected` name the
config file as the reason.
