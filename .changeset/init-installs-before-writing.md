---
'@covsel/core': minor
'covsel': minor
---

`covsel init` now installs the adapter before it writes the config, so a name
nothing provides leaves no config behind. Previously `covsel init --adapter
nope` wrote a `covsel.json` naming `nope` and then handed `@covsel/adapter-nope`
to the package manager, so a registry 404 was the first anyone heard of the
mistake — with a project already configured for an adapter that does not exist,
which every later command then failed on.

The install is the check. covsel keeps no list of adapter names that count:
anyone can publish an adapter, so any name is a candidate, and whether one has a
package behind it is the registry's answer to give. `init` asks the package
manager for `@covsel/adapter-<name>` and, if that comes back empty-handed, for
`covsel-adapter-<name>` — so an adapter published only under the community prefix
now installs from `--adapter <name>` instead of failing on a specifier that was
never published.

The fallback to the community prefix is for a specifier the package manager
turned down, not for a run that never finished: an interrupted install stops
there rather than escalating into a request for a differently-named, unscoped
package the caller never asked for. Support packages such as
`@vitest/coverage-v8` are installed once the adapter is in, so a failure that is
theirs is reported as theirs instead of blamed on the adapter.

When no specifier can be installed, the failure names every command covsel asked
the package manager to run, suggests the adapter the name is a near-miss of when
there is one, and says that no config was written. It does not claim the package
does not exist: a private registry, an offline machine, and a name with nothing
behind it all look the same from here. A project that was already configured is
told its config is unchanged, rather than a "nothing was written" that would read
as a rollback covsel never performed. Ignoring the map directory goes ahead
either way — whether covsel can record has no bearing on whether its output
belongs in version control, and it was a line of the plan the caller agreed to.

`--no-install` is deliberately exempt. It says the project brings its own
packages, which leaves no install to answer the question, so the config is
written on the caller's word — the way in for an adapter arriving from a private
registry, a lockfile, or a workspace link.

`@covsel/core` gains `knownAdapters()` and `suggestAdapter()`, read off the
runner table so a new adapter joins the suggestions along with its runner. They
are help after a failed install, never a gate: an adapter covsel has never heard
of is as acceptable a name as one it ships an adapter for.
