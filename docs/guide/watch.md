# Watch mode

`covsel watch` is the record → affected → run loop, driven continuously instead
of once. It watches your working tree and, on every save, runs the tests that
change can affect.

```bash
covsel record -- node --test    # once, to build the map
covsel watch -- node --test     # then leave this running while you work
```

Everything `covsel run` knows applies here: selection comes from the same map
and the same git diff, so watch is not a second selection policy that can drift
from the first one.

## What triggers a run

A change event only decides _when_ to select, never _what_ to select. Every
batch of changes re-runs the full selection against the git diff, so:

- **Source changes** select through the map — the tests that executed the
  changed code (down to the function, at the default `block` granularity).
- **Test-file changes** always run that test file, whether or not the map has
  ever seen it. That is the core policy for new and edited tests, not something
  watch mode re-decides.
- **Sentinel changes** (`package.json`, a lockfile, `tsconfig*.json`, plus
  anything in your `sentinels` config) force a full run.
- **A change the watcher cannot name** — some platforms report that something
  changed without saying what — still triggers a full selection pass. Nothing is
  skipped for want of a filename.

Changes that git ignores do not trigger a run: a file git ignores cannot appear
in a diff, so it cannot affect selection, and dropping it is what keeps a
runner's own build output from re-triggering the loop forever. If git cannot
answer — no git, not a work tree — every path counts and the batch runs.

::: warning A runner that writes untracked output into your repo
Anything else your command writes inside the watched tree is, to git, a change
like any other — so it triggers the next run, which writes it again. Watch will
not quietly suppress it, because a file it cannot distinguish from your own edit
is one it has to act on. Gitignore the output (reports, logs, build artifacts),
or send it somewhere outside the repo:

```bash
covsel watch -- node --test > /tmp/watch.log    # not ./watch.log
```

:::

## Debouncing

Editors and formatters write in bursts, and a burst should produce one run, not
six. Watch waits for a quiet period after the last change before running;
the default is 200ms.

```bash
covsel watch --debounce 500 -- node --test
```

The quiet period restarts on each change, but only up to a ceiling — five
debounce periods, and never less than a second. Something writing continuously
next door (a `tsc --watch` into a directory git does not ignore) would otherwise
postpone every run indefinitely, which from the outside is indistinguishable
from a watcher that has stopped selecting.

Changes that arrive _during_ a run are collected and produce exactly one
follow-up run when it finishes. Runs never overlap and never queue up behind
each other.

## Does watch update the map?

Not by default. Re-recording costs a full suite run — every test file in its own
process — which is exactly the latency watch mode exists to remove, and it is
not needed for safety: the map stays anchored to the commit it was recorded on,
so as your working tree drifts further from that commit the diff grows and
selection gets _broader_, never narrower. Drift costs precision, not
correctness.

When you want the map kept fresh anyway:

```bash
covsel watch --record -- node --test
```

With `--record`, a run that passes is followed by a re-record — but only when the
working tree is clean. A map is stamped with the commit it was recorded on, so
one recorded from an edited tree would claim to describe code that commit does
not contain; check that commit out again later and covsel would trust a map that
never described it, and could skip a test. So `--record` refreshes the map at
each commit rather than at each save, and says why when it declines.

A run that fails is not followed by a re-record either — coverage from a failing
suite is not something to record. Whenever a re-record is declined or fails, the
previous map stands and watch keeps going; the next selection is then computed
against an older commit, which over-selects.

Use `covsel status` to see how old the map is and whether the next selection
would be a full run.

## Adapters

Watch respects the same per-runner distinction as `covsel run`:

```bash
covsel watch --adapter vitest -- vitest run
covsel watch --adapter node-test -- node --test
covsel watch --adapter cucumber -- npx cucumber-js
```

Adapters that record individual tests (node:test, cucumber-js) narrow below file
level through the runner's own filtering — `--test-name-pattern`, `--name`. The
rest are handed a test-file list, the contract every runner honors. A full run
invokes your command with no filter at all, so the runner runs its own suite.

## Failure behavior

A watch loop that quietly stops selecting is the failure this project exists to
prevent, so:

- **A failing test run never kills the watcher.** It reports the exit code and
  keeps watching.
- **A run that cannot even start** (a bad command, a missing binary) is reported
  and the loop keeps watching.
- **Selection that cannot be computed** — an unreadable or stale map, a moved
  sentinel, git unavailable — falls open to a full run with the reason printed,
  every time, not just the first.
- **A watcher that dies** (an inotify limit, a removed directory) stops the loop
  with a non-zero exit and an explanation. A watcher that is no longer delivering
  events cannot select anything, and sitting there looking healthy would be the
  worst possible outcome.

Stop with `Ctrl-C`; watch exits 0.

## Options

| Option             | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `--adapter <name>` | Runner adapter (default `generic`)                              |
| `--since <ref>`    | Diff against `<ref>` instead of the commit the map records      |
| `--debounce <ms>`  | Quiet period after the last change before running (default 200) |
| `--record`         | Re-record the map after a run that passes                       |
| `--no-initial-run` | Wait for the first change instead of running at startup         |

## Implementation note

Watching uses a single recursive `node:fs` watcher — no third-party file-watching
dependency. Node ≥ 22 supports recursive watching on every platform covsel
targets.
