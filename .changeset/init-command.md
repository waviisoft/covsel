---
'@covsel/core': minor
'covsel': minor
---

Add `covsel init`: detect the project's test runner, persist which adapter
observes it, and add the map directory to `.gitignore`. The adapter choice is
the one consequential decision in adopting covsel and it turns on something
invisible from outside the runner — whether it executes your sources or
transformed copies of them — so `init` makes it once, from the project, and
records it.

`CovselConfig` gains an `adapter` field (`"generic" | "vitest" | "node-test"`,
default `"generic"`), which `record` and `run` now use when no `--adapter` flag
is given; the flag still overrides it, and an adapter name that doesn't exist is
now a loud error from either source rather than a silent fall back.

`init` never persists a fail-closed setup. A runner that transforms sources
before executing them is never resolved to a recorder that reads process
coverage — under one of those, the map would say no test covers your sources, so
a change to them would select nothing at all. That covers both the runners with
no adapter yet (Jest, cucumber-js, Playwright) and an otherwise-supported runner
invoked through a transform hook such as `ts-node` or `tsx`. In those cases
`init` writes nothing, explains the risk, and points at the tracking issues;
`--adapter` overrides it for a caller who knows better, with the under-selection
warning stated rather than implied.

When no runner is recognised at all, `init` prints the environment a useful
adapter request needs — covsel version, Node version, platform, package manager,
the test script and test-related dependencies — alongside a prefilled issue
link. The link itself carries only versions and platform; the project's own
strings stay in the local output for review, since the tracker is public.
