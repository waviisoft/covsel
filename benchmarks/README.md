# benchmarks

Replays merged changes from real repositories through covsel and measures what
selection saved — and, more importantly, whether it ever skipped a test the
change altered.

This is a private workspace package. It is not published and nothing in
`packages/` depends on it.

## Running one

```bash
pnpm build                       # the harness drives the covsel CLI from dist/
pnpm --filter @covsel/benchmarks build

node benchmarks/dist/cli.js \
  --project benchmarks/projects/express.json \
  --head 18e5985b8a9d5e8423db0a9121f22bdaecd5b120
```

The project's pinned `ref` is the **base**: the map is recorded there once and
carried across to each `--head` untouched. That is what CI does with a map
published from the default branch, and it is why no diff window is passed —
selection measures from the commit the map records, and computing a window by
hand would be a second opinion about it.

Clones live in `benchmarks/.work` (gitignored) and are reused between runs.
Results append to `benchmarks/results/<project>.jsonl`.

The harness links the workspace build into each clone rather than installing
`@covsel/*` from a registry, because those packages are not published yet.

## What a run measures

| Field                                     | Meaning                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `selectedTests` / `totalTests`            | How much of the suite selection chose                        |
| `selectedByCoverage` / `selectedByPolicy` | Split by what put a file there — see below                   |
| `outcomesChanged`                         | Test files whose pass/fail the change altered                |
| `unscorable`                              | Files already failing at the base — see below                |
| `misses`                                  | Altered outcomes selection left out. **Must be empty.**      |
| `timings`                                 | Recording, deciding, the selected run, the full run          |
| `wallClockRatio`                          | `(deciding + selected run) / full run` — below 1 is a saving |
| `breakEvenRuns`                           | Selections from one map before recording pays for itself     |

`misses` is the only number that can fail a run: a non-zero value means covsel
did not run a test whose behaviour the change altered, and the CLI exits 1.

**Coverage and policy are counted separately** because reporting one ratio makes
a fail-open improvement look like a precision regression. A release that starts
always running tests it cannot reason about selects strictly more; a benchmark
that only counts files calls that worse. The split keeps the safety rule and the
selector's precision on separate lines.

**A file already failing at the base cannot be scored.** One verdict per file
cannot tell a still-failing file from an unaffected one, so such a file can never
be counted as a miss whatever the change did inside it. `unscorable` reports how
many there were, because `misses: 0` means less when that number is high.

## How outcomes are established

Each test file is run in its own process and its exit status is the verdict.
Every runner reports results differently and the oracle needs the same answer
from all of them; an exit status is the one signal they all give, so this needs
no per-runner parsing.

Those runs are **not** where timings come from. A process per file measures
process startup as much as it measures the suite, so wall-clock numbers come
from whole-suite runs instead.

## Adding a project

Add a JSON file to `projects/`. The fields are validated before anything is
cloned, because a typo that only surfaces an hour into a run costs more than
every check put together.

**A project file is executable code.** Its `install` and `runner` commands are
run as given, and its repository is cloned and its suite executed. Validation
checks their shape, never their content. Review one the way you would review a
script someone asked you to run.

`covsel.testGlobs` must be stated explicitly. covsel fills an unset value from
the adapter's own defaults and the harness does not, so leaving it out lets the
two disagree about which files the suite even contains -- and for an adapter
whose defaults are feature files, the harness would discover none and report a
clean, zero-miss result for a project it never measured.

Globs must contain a `/`. A slash-less glob is also matched against a path's
basename anywhere in the tree, so `sourceGlobs: ["index.js"]` silently grows to
every `index.js` in the repository. Write `./index.js` for the root file, or
`**/index.js` if you did mean all of them.

## Timings are machine-dependent

The same fastify suite measured 38.3s and 45.3s for identical work on one
container. Selection ratios and miss counts are deterministic and can be
compared across machines; wall-clock numbers cannot. Publish them only from a
machine whose specification is published alongside.
