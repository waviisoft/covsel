---
'@covsel/core': minor
'@covsel/adapter-generic': minor
---

The generic recorder no longer claims to observe packages for a command it was
handed. `observesPackages` says that, had a test executed any package's code
anywhere, this recorder would have seen it — and the wrap knows only that it
spawned an argv somebody typed with `NODE_V8_COVERAGE` set and read the dumps
that appeared. A command that drives a browser, shells out to another runtime, or
runs its tests in a container executes code that dump never sees, and looks
exactly like `node --test` from here.

The claim matters because of what it licenses. An entry's `packages` is paired
with an inventory of what was installed, and a package in the inventory that no
entry credits reads as _installed and never ran_, so a bump to it need select
nothing. Claimed for a command whose code runs elsewhere, that reading is applied
to every dependency the recording never watched — and a browser-only dependency
moving would skip the tests that exercise it. Withholding the claim gives up the
precision a bump could have had; making it wrongly skips tests.

Neither the command nor the recording can settle it. An allowlist of runner
binaries still declares for `node run-e2e.mjs` and declines for a shell wrapper
around `node --test`, which is a wrong guess that reads like evidence. Inferring
from the dump can only refute the claim, never establish it: vendored code in the
dump is equally consistent with having missed every package that ran in another
isolate, which is precisely the situation under a browser-driving runner whose
own Node-side dependencies are in there.

So the claim belongs to whoever chose the command. `createGenericRecorder` takes
`runsInNodeProcessTree`, the caller's assertion that the run executes everything
under test in the process tree covsel spawns, and declares `observesPackages`
only when it is set — attributing packages exactly when it stands behind them,
so a unit is silent about them exactly when its recorder is.
`@covsel/adapter-generic` never sets it, because wrapping whatever it is handed
is what the adapter is for. A recording made through it now carries no `packages`
on any entry and no `dependencies` inventory, so it holds no opinion about a
dependency change and answering one is left to the lockfile sentinel, which the
default `sentinels` cover for every package manager covsel recognises.

`observes` stays `OBSERVES_EVERYTHING` on the same recorder. The uncertainty is
identical, but the two claims do not have the same expressive range: withholding
a boolean states it exactly, while `observes` is a set of repo-path globs and
what an unvouched command hides is a process boundary — globs name where in the
repo a path is, never which process ran it. The only narrowing available is the
empty scope, which does not narrow the claim so much as withdraw selection from
covsel's default adapter entirely, and that is not a decision to make as a side
effect of this one.
