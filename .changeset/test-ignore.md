---
'@covsel/core': minor
'covsel': minor
---

Let a project name the tests its runner will not run, with `testIgnore`.

covsel finds test files by walking the tree with `testGlobs`. The runner it wraps
finds them by reading its own configuration. When the runner excludes something
-- a browser suite kept out of the default config and run by a second one -- the
two disagree, and covsel tries to record a test the runner refuses to run.

That is worse than it sounds, because a recording that fails writes **no map at
all**: a partial map cannot be trusted, so one unrunnable file stops the project
selecting anything, and every pull request falls open to a full run until someone
works out why. It is the failure covsel's own `covsel map` workflow hit the day
its Playwright conformance suite arrived.

- `testIgnore` is a glob list of test files to leave alone. They are never
  discovered, never recorded, and never selected. It subtracts from `testGlobs`
  rather than narrowing them, because "every test except this one" is not
  something a glob set can say.
- It applies to discovery alone. A file named here is still a test file
  everywhere that asks what a path _is_, so it cannot be credited as a source of
  its own coverage.
- It wins over `alwaysRun`. The two claims conflict and only one can hold: a file
  the runner will not run cannot be run whatever else the config asks for.
- `covsel status` reports how many files it removed, in both the report and
  `--format json` (`ignoredTestCount`), because an exclusion that grows silently
  is a suite shrinking without anyone deciding to. It is a claim that skips tests
  when it is wrong, so it says itself back to you.
- It is part of the recorded configuration, so changing it forces a full run
  rather than quietly selecting against a map recorded over a different set of
  tests. The first run after upgrading is a full one for the same reason.

A project that names nothing discovers exactly what it did before.
