# Using covsel in CI

Locally you record a map and select against your working tree. In CI the map has
to come from somewhere else: you **publish** it from the default branch and
**restore** it on pull requests, so a PR job can select without recording the
whole suite first.

## The map is a snapshot of one commit

Every map records the commit it was recorded on, and that commit is what
selection measures change from. This is the single most important thing to
understand about running covsel in CI.

A map published on `main` at commit `C` and restored onto a PR branch does not
describe the PR's tree — it describes `C`. So covsel diffs from `C`, which
covers both the PR's own changes _and_ anything that landed on `main` in
between. Measuring only from the merge-base would silently ignore those
in-between commits and skip tests whose code changed.

Two cases resolve to a **full run**, loudly, rather than a quiet under-selection:

- The map records a commit this checkout does not have — a shallow clone, or a
  rebased or pruned history. Fetch enough history (`fetch-depth: 0`) to fix it.
- The map records no commit at all, so the window since recording is unknowable.

Both are reported by `covsel status` under `next:`.

## The archive: keep several maps, and pick the right one

Keeping only the newest map is the obvious thing and the wrong thing. The newest
map was recorded on whatever commit was current when it was written, and that may
be a commit your pull request's checkout has never heard of — another branch, a
force-push, a pruned history. covsel then falls open to a full run, which is safe
and costs you the minutes you installed covsel to save, while a slightly older
map recorded on an ancestor of your branch would have selected perfectly.

So covsel keeps maps in an **archive**, addressed by the commit each was recorded
on, and picks between them:

```bash
covsel publish   # add the recorded map to the archive, under its commit
covsel fetch     # install the best archived map as this checkout's map
```

`fetch` prefers the most recently recorded map whose commit is an **ancestor of
`HEAD`** — the tight case, and the one a pull request hits. Failing that it takes
the newest commit your checkout _has_, which still selects soundly (covsel diffs
that commit's tree against yours directly, so nothing is missed) but diffs more
files, so it over-selects. Failing that too, it installs nothing and the next run
is a full one. It says which it did, and why the others were passed over:

```
covsel fetch: skipped 3f2a1c9e8b7d -- not in this checkout (fetch more history?)
covsel fetch: installed the map recorded at 9c81de4a2f60 (2026-07-28T04:11:02.884Z) to /repo/.covsel/map.json
```

The archive lives at `.covsel/archive` by default, so whatever you already cache
to carry `.covsel` between jobs carries it too. `--archive <dir>` puts it
somewhere else — a shared volume, an artifact directory. Publishing keeps the 20
newest maps and prunes the rest; `--keep <n>` changes that.

Two things `publish` refuses, both loudly:

- A map that records **no commit**, since nothing could ever measure change from
  it. That is what a map recorded from a dirty working tree looks like, so
  publish from a clean checkout.
- A commit that is not a commit hash, so a hand-edited map cannot decide where
  covsel writes.

## Publish on the default branch

Record the map on `main` and add it to the archive. Restore the archive first, so
publishing grows it rather than replacing it — an archive of exactly one map is
the problem this section opened with:

```yaml
name: covsel map

on:
  push:
    branches: [main]

concurrency:
  group: covsel-map # two records would race on the cache key
  cancel-in-progress: false

jobs:
  record:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # selection needs history back to the recorded commit
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm ci
      - uses: actions/cache/restore@v4
        with:
          path: .covsel/archive
          key: covsel-archive-${{ github.sha }}
          restore-keys: covsel-archive-
      - run: npx covsel record -- npm test
      - run: npx covsel publish
      - uses: actions/cache/save@v4
        with:
          path: .covsel/archive
          key: covsel-archive-${{ github.sha }}
```

## Fetch on pull requests

```yaml
name: PR tests

on: pull_request

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm ci
      - uses: actions/cache/restore@v4
        with:
          path: .covsel/archive
          key: covsel-archive-${{ github.sha }}
          restore-keys: covsel-archive-
      - run: npx covsel fetch
      - run: npx covsel status
      - run: npx covsel run -- npm test
```

No archive means no map, which means a full run — the safe default. Nothing about
a missing or stale map can cause a test to be skipped, so `fetch` exits 0 when it
finds nothing usable and says the next run will be a full one. A job that would
rather know asks with `--require`, which exits non-zero instead.

`fetch` will not overwrite a local map recorded more recently than the archived
one — that only happens on a developer's machine, where the local recording is
the better map. `--force` overrides it.

## covsel's own CI does this

The workflows in this repository are the worked example:
[`.github/workflows/covsel-map.yaml`](https://github.com/waviisoft/covsel/blob/main/.github/workflows/covsel-map.yaml)
records and publishes on `main`, and the `select` job in
[`.github/workflows/ci.yaml`](https://github.com/waviisoft/covsel/blob/main/.github/workflows/ci.yaml)
fetches and runs the affected tests on every pull request.

One detail there is worth copying: the selecting job runs **alongside** the job
that runs the whole suite, not instead of it. Until you trust a selection, the
full run is what gates the merge and the selected run is what you compare it
against.

## Sharded suites

When CI splits the suite across jobs, each shard records the part it ran. Merge
the shard maps into one before publishing:

```bash
covsel merge shard-1/map.json shard-2/map.json --out .covsel/map.json
```

Merging unions the entries, and unions the covered files and blocks of any test
that appears in more than one shard. Three rules keep the result honest:

- Granularity drops to `file` unless **every** shard recorded blocks, so a
  partly block-aware map never narrows selection by blocks.
- `recordedAt` is the oldest shard's — the map is only as fresh as its stalest
  part.
- The commit survives only if every shard agrees on it. Shards recorded at
  different commits describe different trees, so the merged map records no
  commit and the next selection is a full run. Record every shard from the same
  checkout to avoid that.

## Keeping the map fresh

Selection is only as good as the map. Re-record on the default branch on every
push (or on a schedule) so the window between the recorded commit and a PR stays
small: the larger that window, the more files show up as changed and the more
tests get selected. Over-selection is the safe direction, but it costs the time
you installed covsel to save. `covsel status` reports the map's age and whether
the next selection would be a full run.
