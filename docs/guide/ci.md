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

## Publish on the default branch

Record the map on `main` and cache it. The store is just a directory, so
`actions/cache` is all you need:

```yaml
name: covsel map

on:
  push:
    branches: [main]

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
      - run: npx covsel record -- npm test
      - uses: actions/cache/save@v4
        with:
          path: .covsel
          key: covsel-map-${{ github.sha }}
```

## Restore on pull requests

Restore the newest map with `restore-keys` — an older map is still safe, because
selection measures from the commit that map records:

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
          path: .covsel
          key: covsel-map-${{ github.sha }}
          restore-keys: covsel-map-
      - run: npx covsel status
      - run: npx covsel run -- npm test
```

No cache hit means no map, which means a full run — the safe default. Nothing
about a missing or stale map can cause a test to be skipped.

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
