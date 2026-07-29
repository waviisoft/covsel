---
'@covsel/core': minor
'covsel': minor
---

Add `covsel init`: set a project up for covsel in one command. It reads
`package.json` to work out which runner the project uses, shows what it found,
and — once you confirm — installs that runner's adapter with the project's own
package manager, writes the adapter to a `covsel.json`, and keeps the map
directory out of version control.

Now that covsel ships no adapters, which package to install is the first
question in adopting it, and the answer is already in the project's
dependencies. `init` also installs what recording needs beyond the adapter
itself — Vitest's coverage provider, which the Vitest adapter reads through — so
setup does not end with a config that looks complete and fails at the first
`record`.

Detection is shown before anything happens, because detection can be wrong and a
wrong adapter is a config that looks settled while recording nothing useful.
`-y` skips the prompt, `--no-install` writes the config and installs nothing, and
`--adapter <name>` names one yourself. Without a terminal to ask — CI, a script,
a coding agent — `init` proceeds, since running it is itself the intent. If the
install fails, the config is still correct and the exact command that finishes
the job is printed rather than left implied.

`CovselConfig` gains an optional `adapter`, which `record`, `affected`, `run`,
and `watch` fall back to when `--adapter` is not given — the flag still wins, and
an unset field still means the default. It is the one config field with no
default in core, because core cannot name an adapter that is certain to be
installed.

`init` does not guess. A runner covsel has no signature for is reported rather
than resolved to the generic wrap on the theory that something beats nothing: it
writes nothing, prints the environment an adapter request needs — covsel
version, Node version, platform, package manager, the test script and
test-related dependencies — and links the prefilled issue. That link carries only
versions and platform; the project's own strings stay in the local output for
review, since the tracker is public. A project running a suite covsel cannot
record yet (Playwright) is told to keep running it in full.

For programmatic use, `planInit` works out what would happen and touches
nothing, and `applyInit` carries a plan out; a plan that could not name an
adapter is inert when applied.
