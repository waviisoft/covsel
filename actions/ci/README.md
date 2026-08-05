# covsel-action

Run only the tests your diff can affect, and record the map that makes that
possible.

> **This repository is a deployment target.** The source lives in
> [waviisoft/covsel](https://github.com/waviisoft/covsel) under `actions/ci`, and
> every release is published here by that repository's release workflow. Please
> do not open issues or pull requests here -- they belong
> [there](https://github.com/waviisoft/covsel/issues).

**Requires covsel in your project.** The action runs the covsel your project
installed; `covsel-version` pins one for a project that does not. It is `v0`
while covsel itself is early -- the major tag floats to the newest release under
it, so `@v0` keeps up and `@v0.1.0` does not.

## Select, on a pull request

```yaml
name: PR tests
on: pull_request

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0 # selection measures change from the commit the map records
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm ci
      - uses: waviisoft/covsel-action@v0
        with:
          command: npm test
```

## Record, on the default branch

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
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm ci
      - uses: waviisoft/covsel-action@v0
        with:
          mode: record
          command: npm test
```

## Start with a dry run

Until you trust a selection, the full run is what gates the merge and the
selected run is what you compare it against. `dry-run` reports what covsel would
have chosen and runs nothing, so it can sit beside the suite you already have:

```yaml
- uses: waviisoft/covsel-action@v0
  with:
    command: npm test
    dry-run: true
```

## Inputs

| Input               | Default           | What it does                                                                   |
| ------------------- | ----------------- | ------------------------------------------------------------------------------ |
| `mode`              | `select`          | `select` on a pull request, `record` on the default branch                     |
| `command`           | _required_        | The runner command, e.g. `npm test`. Split on whitespace.                      |
| `adapter`           | your config's     | The covsel adapter to record and select with                                   |
| `covsel-version`    | your project's    | An npm version to run instead of the covsel your project installed             |
| `covsel-command`    |                   | Override the executable entirely; for testing the action against covsel itself |
| `working-directory` | `.`               | Directory to run covsel in                                                     |
| `archive-path`      | `.covsel/archive` | The archive directory, carried between runs by the Actions cache               |
| `cache-key-prefix`  | `covsel-archive-` | Prefix for the archive cache key                                               |
| `require-map`       | `false`           | Fail when no archived map can be used, instead of falling open to a full run   |
| `dry-run`           | `false`           | `select` only: report the selection and run nothing                            |
| `keep`              | covsel's default  | `record` only: archived maps to keep, oldest pruned first                      |
| `summary`           | `true`            | Write a job summary describing the selection                                   |

## Outputs

| Output             | What it is                                                                      |
| ------------------ | ------------------------------------------------------------------------------- |
| `full-run`         | `true` when covsel could not narrow and every test runs                         |
| `full-run-reason`  | Why, when it is                                                                 |
| `selected-count`   | Test files selected                                                             |
| `discovered-count` | Test files discovery found -- the denominator the count means something against |
| `affected`         | The selected test files as a JSON array, for `fromJSON()` into a shard matrix   |
| `map-state`        | `usable`, `absent`, or `unusable`                                               |
| `map-commit`       | The commit the map records, which selection measured change from                |
| `map-age-ms`       | How old the map is                                                              |

**Branch on `full-run`, never on the length of `affected`.** A full run
enumerates every discovered test file, because that is what has to run; treating
that list as a selection to filter by is the one mistake that runs nothing on
exactly the runs that need everything.

## What it does, and what it will not do

`select` restores the archive, installs the best map this checkout can measure
change from, reports what that means, and runs the affected tests through
`covsel run` -- which on a full run hands your runner its own command with no
file filter. `record` restores the archive, records the suite, publishes the map
under the pushed commit, and saves the archive back.

Nothing here can cause a test to be skipped. No archived map is not a failure:
the tests still have to run, so they run in full and the step succeeds. Set
`require-map: true` if you would rather know.

## License

[MIT](./LICENSE)
