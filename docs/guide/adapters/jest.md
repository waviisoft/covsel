# Jest adapter

`@covsel/adapter-jest` records per-file coverage for [Jest](https://jestjs.io)
suites.

## Why a dedicated adapter

Jest compiles your code through its transformer — babel-jest, ts-jest, SWC — and
evaluates the result from its own module registry. Raw `NODE_V8_COVERAGE` at the
process boundary looks deceptively usable here: the dump does name your
`src/**` files. But the offsets in it address the **transformed** module source,
not the file on disk — in a measured run, a function in a 113-byte source came
back at bytes 144–216, past the end of the file it claims to describe. File
attribution would survive that; function-level attribution, covsel's default
granularity, would be silently wrong.

Instead, this adapter enables **Jest's own coverage**, which remaps execution
back to your original sources through the transformer's source maps, and reads
the resulting istanbul `coverage-final.json`.

## Setup

None. Coverage is built into Jest, so there is nothing to install and no
`jest.config` change to make — the adapter passes the coverage flags it needs on
the command line, and leaves your `coverageProvider` alone.

## Record → affected → run

```bash
# Build the map with the jest adapter
covsel record --adapter jest -- jest

# Print the test files your working-tree diff can affect
covsel affected

# Run only those
covsel run --adapter jest -- jest   # or: jest $(covsel affected)
```

Under the hood, `record` runs Jest once per test file with coverage enabled and
a JSON reporter, then keeps the sources that file actually executed.

## Notes

- Recording pins each run to a single file with `--runTestsByPath`. Bare
  positional arguments are regexes matched against every test path, so without
  it one test file's entry could absorb coverage from files it merely resembles.
- A configured `coverageThreshold` is neutralised while recording. Observing one
  test file at a time would trip a threshold meant for a whole run, and recording
  is an observation pass, not a quality gate.
- Granularity is per **file**: one recorded unit per test file, so a change to a
  source it covered selects the whole file rather than the individual test.
- A runnable end-to-end example lives in
  [`examples/jest-basic`](https://github.com/waviisoft/covsel/tree/main/examples/jest-basic).
