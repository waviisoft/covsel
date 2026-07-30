# Getting started

Selection ships today: `covsel record`, `affected`, `run`, `watch`, `status`,
and `merge` -- with function-level (block-hash) precision, per-test selection for
node:test, and scenario-level selection for cucumber-js. Running covsel in CI is
covered in the [CI guide](/guide/ci).

## Requirements

- Node >= 22 (the V8 inspector and `NODE_V8_COVERAGE` are stable there)
- pnpm (via `corepack enable`) if you are working on covsel itself
- For Vitest, `@vitest/coverage-v8` in your project (see the
  [Vitest adapter](/guide/adapters/vitest))

## Install

covsel ships no adapters — one per runner, installed separately — so setting up
means installing the CLI plus the right adapter. `covsel init` works out which
one that is:

```bash
npm install --save-dev covsel
npx covsel init
```

`init` reads your `package.json`, works out which runner you use, and shows you
what it found before touching anything:

```
covsel init: detected vitest — vitest is a dependency (adapter vitest)

Plan:
  install  @covsel/adapter-vitest, @vitest/coverage-v8 (pnpm)
  write    covsel.json (adapter: vitest)
  ignore   the map directory in .gitignore

Set covsel up this way? [Y/n]
```

Confirm and it installs the adapter with your own package manager — plus
anything else recording needs, like Vitest's coverage provider — writes the
adapter to the config so later commands need no `--adapter`, and keeps the map
out of version control. Detection is worth a glance before you say yes: a wrong
adapter is a config that looks settled and records nothing useful.

Decline and nothing happens at all — no config, no install. That is what "no"
means; `--no-install` is how you ask to be configured without an install.

| Flag               | What it does                                 |
| ------------------ | -------------------------------------------- |
| `--auto-approve`   | Carry the plan out without asking            |
| `--no-install`     | Plan to configure without installing         |
| `--adapter <name>` | Use this adapter instead of the detected one |

`--no-install` changes the plan rather than skipping the question: the packages
it will not install are listed under `skip`, with the command you will need, and
you still confirm before anything is written.

**`init` is interactive.** It writes files and installs packages, so it does
nothing without an answer. With no terminal to ask — CI, a script, a coding
agent — it prints the plan, changes nothing, and exits non-zero; pass
`--auto-approve` to authorise an unattended run.

`init` does not guess. A runner it has no signature for is reported, along with
a link for requesting an adapter and the environment such a request needs, and
nothing is written — pass `--adapter <name>` to name one yourself.

Nor does it keep a list of adapter names that count. Anyone can publish an
adapter, so a name you pass to `--adapter` is a candidate whatever it is: `init`
looks for it under `@covsel/adapter-<name>` and then `covsel-adapter-<name>`, and
if neither is installed it asks your package manager for them, in that order.
Whether the name has a package behind it is the registry's answer, not covsel's.

The install runs before the config is written, so a name nothing provides leaves
you with no config naming an adapter that does not exist for every later command
to fail on. When no specifier can be installed, `init` prints what it asked for,
suggests the adapter you probably meant if the name is a near-miss of one covsel
knows, and stops. The one thing it still does is add the map directory to your
`.gitignore`: that line never depended on the install, you agreed to it, and it
keeps `.covsel/` uncommittable whether or not setup finished. `--no-install` is
the exception to the withheld config: with no install to answer the question, it
is written on your word, which is the way in for an adapter you install by other
means.

### Or choose the adapter yourself

```bash
npm install --save-dev covsel @covsel/adapter-generic   # any command, whole-file
npm install --save-dev covsel @covsel/adapter-vitest    # Vitest
npm install --save-dev covsel @covsel/adapter-jest      # Jest
npm install --save-dev covsel @covsel/adapter-node-test # node:test, per test
npm install --save-dev covsel @covsel/adapter-cucumber  # cucumber-js, per scenario
```

Adapters are separate packages because most projects need exactly one: bundling
five runners' worth of code into every install would make you carry four you
will never load. A name covsel does not find is reported with the package to
install, so a missing one is never a mystery. [Adapters](/guide/adapters/) has
the full picture.

## The loop

```bash
# 1. Record: build the test -> covered-source map (one process per test file)
covsel record -- node --test
covsel record --adapter vitest -- vitest run   # needs @vitest/coverage-v8
covsel record --adapter jest -- jest           # coverage is built into Jest

# 2. Affected: print the test files your working-tree diff can affect
covsel affected
covsel affected --since origin/main

# 3. Run: run only those tests by wrapping the runner
covsel run -- node --test

# 4. Watch: keep running the affected tests as you edit
covsel watch -- node --test
```

`affected`, `run`, and `watch` resolve an adapter just as `record` does: the
`--adapter` flag first, then the adapter `covsel init` wrote to your config,
then `generic`. The lines above use the default; a project that skipped `init`
passes the flag to each command.

[Watch mode](/guide/watch) drives the same selection continuously — one run per
save, debounced, falling open to a full run whenever it cannot tell what a
change affects.

`covsel affected` prints a newline-separated file list, so you can also pipe it
into any runner that accepts test files:

```bash
node --test $(covsel affected)
```

### Inspect the map

```bash
covsel status
```

shows the store path, the map's age and size, whether any sentinel changed since
record, and whether the next `affected` would be a full run.

## Which adapter?

Selection is zero-config, but recording depends on how your runner executes
code:

- **Runners that execute source directly** (`node --test`, Mocha on plain JS)
  use the [generic adapter](/guide/adapters/generic), which wraps any command
  and is what `--adapter` defaults to.
- **Runners that transform sources** (Vitest, Jest) need a runner-specific
  adapter, because raw process coverage can't see transformed code. See
  [Adapters](/guide/adapters/) for the full picture.

## Configuration

Selection needs no configuration once an adapter is installed. To refine, add a `covsel.json` (or
`covsel.config.js`) at your repo root:

```jsonc
{
  "adapter": "vitest", // the installed adapter to record with; --adapter overrides
  "testGlobs": ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  "sourceGlobs": ["**/*"], // repo minus node_modules/dist/coverage/.covsel and tests
  "alwaysRun": ["**/fixtures/**"], // test files that must always run
  "sentinels": ["package.json", "pnpm-lock.yaml", "tsconfig*.json"],
  "granularity": "block", // "block" (function-level) | "file"
  "store": {
    "dir": ".covsel",
    "archiveDir": "archive", // where publish/fetch keep maps by commit, under dir
  },
}
```

Any change matching `sentinels` forces a full run; see
[the fail-open guarantee](/guide/fail-open).

### Bundled code

If your tests exercise their sources through a bundle, covsel needs the build's
source maps to know what that bundle is — a script it cannot map back to a
source fails the recording rather than crediting nothing. Build with source maps
on, and tell covsel where to find the assets when the runner only ever names
them by URL:

```jsonc
{
  "sourceMaps": {
    // Serve-time URLs → the directory holding the built assets.
    "buildDirs": [{ "urlPrefix": "http://localhost:5173/", "dir": "dist" }],
    "http": true, // fetch scripts and maps that are not on disk
    "allowUnmappable": [], // scripts you accept never being able to map
  },
}
```

### Granularity

At the default `block` granularity, covsel records which **functions** each test
executed (fingerprinted by content hash, so reformatting and line shifts don't
matter). Editing one function then selects only the tests that actually ran it,
even when several tests import the same file; a top-level edit, or anything
covsel can't parse into blocks, falls back to selecting every test on that file.
Set `"granularity": "file"` to record and select at whole-file granularity only.

## Working on covsel

```bash
git clone https://github.com/waviisoft/covsel
cd covsel
pnpm install
pnpm build && pnpm test
pnpm lint && pnpm typecheck
```

See [CONTRIBUTING.md](https://github.com/waviisoft/covsel/blob/main/CONTRIBUTING.md)
for how to write an adapter -- the primary community contribution surface.
