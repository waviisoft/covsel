# Generic adapter

`@covsel/adapter-generic` is the adapter covsel uses when you name none. It wraps
**any** runner command: for each test file, covsel runs that file in its own
process with `NODE_V8_COVERAGE` set and attributes the coverage back to your
sources. Zero runner integration, and nothing runner-specific to configure.

## When to use it

Use the generic adapter for runners that **execute your source directly**, so V8
records real `file://` paths:

- `node --test` (JavaScript, or TypeScript under a loader such as `tsx` that
  preserves file URLs)
- Mocha on plain JavaScript — for per-test selection, see the
  [Mocha adapter](/guide/adapters/mocha)

If your runner **transforms sources first** (Vitest, Jest), raw
`NODE_V8_COVERAGE` cannot see them — use a runner-specific adapter such as the
[Vitest adapter](/guide/adapters/vitest) instead.

## Setup

Install it. covsel bundles no adapters, so the default name still resolves to a
package your project has to have:

```bash
npm install --save-dev covsel @covsel/adapter-generic
```

With that in place, every command below works with no `--adapter` flag and no
configuration.

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
- A test that reaches its code through a **bundle** needs that build's source
  maps: a script covsel cannot map back to a source fails the recording rather
  than crediting nothing. See
  [a script that cannot be mapped](/guide/fail-open#a-script-that-cannot-be-mapped).
- A generic recording records **no package information**. Whether a run executes
  all of its code in the process tree covsel spawns is a fact about your command,
  and an adapter that wraps whatever you hand it cannot know one — so it does not
  claim to have watched your dependencies, and the map holds no opinion about
  them. A dependency change is answered by the lockfile sentinel instead, which
  the default `sentinels` cover for npm, pnpm, and yarn.
- Discovery, source globs, and sentinels are controlled by
  [configuration](/guide/getting-started#configuration); zero-config works out
  of the box.
- Runnable end-to-end examples live in
  [`examples/node-test-basic`](https://github.com/waviisoft/covsel/tree/main/examples/node-test-basic)
  (zero dependencies) and
  [`examples/mocha-basic`](https://github.com/waviisoft/covsel/tree/main/examples/mocha-basic)
  (the same loop against Mocha, with no Mocha-specific code).
