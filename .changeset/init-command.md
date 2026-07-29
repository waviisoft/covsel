---
'@covsel/core': minor
'covsel': minor
---

Add `covsel init`: name the adapter for the runner a project already declares,
write it to the config, and add the map directory to `.gitignore`.

Now that covsel ships no adapters, the first question in adopting it is which
adapter package to install — a question whose answer is already sitting in
`package.json`. `init` reads it off the dependencies and test script, writes the
name down once, and prints the `npm install` command when the package is not
there yet. A name in the config that nothing provides would otherwise look
settled right up until the first `record` failed.

`CovselConfig` gains an optional `adapter`, which `record`, `affected`, `run`,
and `watch` fall back to when `--adapter` is not given — the flag still wins, and
an unset field still means the default. It is the one config field with no
default in core, because core cannot name an adapter that is certain to be
installed.

`init` does not guess. A runner covsel has no signature for is reported rather
than resolved to the generic wrap on the theory that something beats nothing:
it writes nothing, prints the environment an adapter request needs — covsel
version, Node version, platform, package manager, the test script and
test-related dependencies — and links the prefilled issue. That link carries
only versions and platform; the project's own strings stay in the local output
for review, since the tracker is public. `--adapter` names one yourself when you
know better, and a project running a suite covsel cannot record yet (Playwright)
is told to keep running it in full.
