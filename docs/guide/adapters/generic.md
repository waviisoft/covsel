# Generic adapter

`@covsel/adapter-generic` is the default. It wraps **any** runner command: for
each test file, covsel runs that file in its own process with `NODE_V8_COVERAGE`
set and attributes the coverage back to your sources. Zero runner integration,
nothing to install.

## When to use it

Use the generic adapter for runners that **execute your source directly**, so V8
records real `file://` paths:

- `node --test` (JavaScript, or TypeScript under a loader such as `tsx` that
  preserves file URLs)
- Mocha on plain JavaScript

If your runner **transforms sources first** (Vitest, Jest), raw
`NODE_V8_COVERAGE` cannot see them — use a runner-specific adapter such as the
[Vitest adapter](/guide/adapters/vitest) instead.

## Setup

None. The generic adapter is built in and used when you pass no `--adapter`.

## Record → affected → run

```bash
# Build the map: runs `node --test <file>` once per test file under coverage
covsel record -- node --test

# Print the test files your working-tree diff can affect
covsel affected

# Run only those (covsel appends the selected files to your command)
covsel run -- node --test
```

`covsel record -- <command>` appends each discovered test file to `<command>`
and runs it in isolation, because per-file attribution needs one process per
test file. Every runner accepts a trailing test-file argument
(`node --test <file>`, `mocha <file>`, …), which is what makes the wrap
universal.

## Notes

- A test file whose run **fails** invalidates its coverage; `covsel record` will
  not write a partial map. Fix the failing test and re-record.
- Discovery, source globs, and sentinels are controlled by
  [configuration](/guide/getting-started#configuration); zero-config works out
  of the box.
