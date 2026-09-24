# Playwright adapter

`@covsel/adapter-playwright` brings **per-test** selection to
[Playwright](https://playwright.dev) by recording what each test executes **in
the browser**, and attributing it to that test.

E2E minutes are the most expensive minutes in CI, and static selection cannot
help: Playwright's own `--only-changed` walks the import graph of your _spec_
files, which cannot see through the HTTP boundary to know which application code
a spec exercises. Runtime coverage can.

## What it observes, and what it does not

A Playwright test executes code in three places: the worker running the spec, the
browser showing your application, and usually a server behind it. This adapter
observes **the browser**, and — when you ask it to — **the server** as well.

Whatever is left is not a gap covsel hides. The scope you declare in `observes`
is written into the map, and every change outside it forces a full run rather
than being read as code no test covers:

```console
$ covsel affected
covsel: full run -- server/api.ts changed, which the recording could not observe (measured since the map was recorded at a1b2c3d4e5f6)
```

So you get real selection on client changes, and no opinion at all about the
rest. The trade is explicit, and it is the reason `observes` has no default:

```json
{
  "adapter": "playwright",
  "observes": ["src/**"]
}
```

Declare a path only when, had code there run, the recording would have seen it.
**Under-claiming costs CI minutes; over-claiming skips tests.** Scope globs are
matched strictly — no basename widening — because a path wrongly counted as
observed suppresses the full run it should have caused. Without `observes`,
`covsel record` refuses to start rather than guess.

The claim and the setup have to match. Adding `server/**` to `observes` without
also [observing the server](#selecting-on-server-changes-too) is the one
misconfiguration covsel cannot catch for you: the map would say the server was
watched, and a change there would then select nothing at all.

## Setup

Install the adapter, then extend your `test` object with covsel's fixture:

```bash
npm install --save-dev covsel @covsel/adapter-playwright
```

```ts
// tests/fixtures.ts
import { test as base, expect } from '@playwright/test';
import { covselFixtures } from '@covsel/adapter-playwright/fixture';

export const test = base.extend(covselFixtures());
export { expect };
```

Import `test` from that file in your specs instead of from `@playwright/test`.
Outside a recording `covselFixtures()` returns nothing at all, so your selected
runs — almost every invocation — are exactly what they were.

## Record → affected → run

```bash
# Build the map: one playwright invocation, one webServer boot, one entry per test
covsel record --adapter playwright -- playwright test --project=chromium

# Print the spec files the diff can affect
covsel affected --adapter playwright

# Run only the affected tests
covsel run --adapter playwright -- playwright test
```

`covsel run` invokes Playwright over the affected spec files with a `--grep`
pattern built from the affected test titles. The pattern is anchored at its end
only, because Playwright matches it against a title it has prefixed with the
project name — a map recorded on Chromium therefore still selects the same test
under Firefox and WebKit. Spec files that must run in full — a new or changed
spec — are run without a pattern.

## Recording is a Chromium mode

Coverage comes from Chromium's JS coverage API, so the **recording** has to run
against a Chromium project. The browsers a _selection_ runs on are unconstrained:
the map says which tests a change affects, and those tests then run on whatever
your suite runs on.

A browser that reports no coverage fails the recording rather than quietly
keeping less. That is deliberate — a recording that observed nothing would say
your tests cover no application code, and skip all of them on every diff
afterwards.

## Record against the dev server

Point the recording at your dev server (Vite, or anything serving modules close
to 1:1 with your sources). A dev server inlines little or nothing, so the
projection back to your sources keeps **block granularity** — which is where the
value is, because in a bundled SPA every statically imported module's top level
runs on page load, so every test records every module and file granularity
selects everything.

Bind that server to the address your `webServer.url` names, rather than to
`localhost`. A CI runner resolves `localhost` to `::1` as well as `127.0.0.1`,
and a server that picks the first is invisible to a `url` naming the other — a
failure that shows up only as `Timed out waiting from config.webServer`, long
after the thing that caused it:

```js
webServer: {
  command: 'vite dev --host 127.0.0.1 --port 5173 --strictPort',
  url: 'http://127.0.0.1:5173',
},
```

Against a minified production bundle, selection degrades toward file level:
code inlined into several callers cannot be called idle by a range that never
ran, so covsel keeps those blocks marked executed. That is the safe direction,
and it is why the dev server is the route to record against.

## Selecting on server changes too

Browser-only, a change to your server falls open to a full run — never wrong,
never a minute saved either. Point covsel at the server as well and a change
there selects the tests that reached it.

Start the application with Node's inspector open, and tell the fixture where:

```js
// playwright.config.js
webServer: { command: 'node --inspect=9229 server/index.js', url: '...' },
workers: 1,
```

```ts
// tests/fixtures.ts
export const test = base.extend(
  covselFixtures({
    browser: { observes: ['src/**'] },
    server: { observes: ['server/**'], inspectUrl: 'http://127.0.0.1:9229' },
  }),
);
```

```json
{ "adapter": "playwright", "observes": ["src/**", "server/**"] }
```

Each window says what it alone could see, and covsel unions them onto the test.
That separation is the point: without it a browser recording would vouch for the
server, which is how a server change comes to skip the tests it breaks. The
config's `observes` stays the union, and recording refuses any window claiming
more than it.

Nothing of covsel runs inside your server either way. What differs below is
_how_ it reaches in from the outside — over the same inspector connection, but
with or without the server's help getting block-level detail for the code it
loads once at boot.

### Block granularity for boot-loaded code too

Add `coverageDir` and start the server with `NODE_V8_COVERAGE` as well as
`--inspect`. Use an absolute path for both: `webServer.command` and the
fixture run in different processes, and a relative `NODE_V8_COVERAGE` is
resolved by the shell that launches the server while a relative `coverageDir`
is resolved by whatever the Playwright worker's own cwd happens to be —
nothing guarantees the two agree.

```js
// playwright.config.js
import { fileURLToPath } from 'node:url';

const coverageDir = fileURLToPath(new URL('.covsel/server-cov', import.meta.url));

export default {
  webServer: {
    command: `NODE_V8_COVERAGE=${coverageDir} node --inspect=9229 server/index.js`,
    url: '...',
  },
  workers: 1,
  // ...
};
```

```ts
// tests/fixtures.ts
import { fileURLToPath } from 'node:url';

const coverageDir = fileURLToPath(new URL('../.covsel/server-cov', import.meta.url));

export const test = base.extend(
  covselFixtures({
    browser: { observes: ['src/**'] },
    server: {
      observes: ['server/**'],
      inspectUrl: 'http://127.0.0.1:9229',
      coverageDir,
    },
  }),
);
```

With `NODE_V8_COVERAGE` set, V8 collects precise, block-level coverage from the
moment the process starts — every function in every module, including the ones
that never run. The fixture reads a "boot" dump before the first test (whatever
ran while the server was starting up, credited to every test, because every test
depends on it) and one delta per test after that (read straight off disk, since
the recording and the server share a host). A module the server loads at boot
keeps real block granularity: an unrelated function in the same file that no
test ever calls stays out of every test's coverage, the same as a module loaded
on demand.

Requires the server on Node ≥22.3 (`process.getBuiltinModule`) and a filesystem
this process can read `coverageDir` from — true whenever the server and the
recording run on the same host, which a local `webServer` always does.

**Concurrent or ambiguous attribution fails the recording.** A worker thread or
a child Node process inherits `NODE_V8_COVERAGE` and writes its own dump into
the same directory; there is no reliable way to say which test its execution
belongs to, so a window that sees one fails rather than guessing.

That guard only fires once such a dump actually appears — a short-lived child
does, because Node writes one on exit even with nothing in it calling
`takeCoverage()` itself. A worker or child that outlives the recording instead
(a cluster worker, a long-running queue processor) never writes one during it,
so there is nothing for the guard to see: whatever it executed is simply
absent from every test's coverage, silently, the same gap the fallback below
already has for a worker thread or child process it cannot reach over the
inspector at all. Route server-side work the recording needs to see through
the main thread, or accept that a long-lived worker's own code needs a
recording of its own.

If the server shells out to another Node process (spawning a worker, running a
build step, whatever), keep that child off the recording's directory before
spawning it:

```js
delete process.env.NODE_V8_COVERAGE;
execFileSync(process.execPath, ['./worker.mjs']);
```

Passing a narrower `env` to `spawn`/`execFileSync` is **not** enough on its
own — an active `NODE_V8_COVERAGE` still reaches the child from the running
process's own environment regardless of what the call site passes, so it has
to be removed from `process.env` itself, not merely left out of the object
handed to `spawn`. Deleting it does not touch the server's own coverage, which
was already switched on at bootstrap.

### Without `coverageDir`: file granularity for whatever boot already did

Leave `coverageDir` unset and the server window falls back to a session opened
fresh inside each test and closed at its end — what comes back is exactly what
that test made the server do, with no baseline to subtract.

**Record with `--workers=1`.** The window is collected from the one server
process, so a second worker's test executing there at the same time would be
credited to this one — or would stop this one's collection mid-test, which
records a test as covering less of the server than it does. The fixture refuses
rather than guess which happened. Only the _recording_ is serial; the selected
runs afterwards are not.

**Expect file granularity for whatever the server loaded at boot.** Coverage
starts when the test does, and V8 reports only functions that ran since — so for
a module the server loaded at boot an un-run function is absent rather than
zero-counted, covsel reads it as executed, and a change anywhere in that file
selects every test that executed it. A module first imported _during_ the test
is compiled inside the window, so its un-run functions are reported and it keeps
real block granularity.

Splitting handlers across modules, and loading them on demand, is what buys
precision here without `coverageDir`. With it, block granularity holds for
boot-loaded code too.

A file both windows see falls back to file granularity, because a window that
recorded no blocks for it cannot vouch for the other's.

## Scripts covsel cannot map

Every script the browser executes has to resolve back to a source, or the
recording fails naming it — a script covsel cannot account for is coverage the
map is missing, not a test that covered nothing.

Dev servers serve their own machinery alongside your code, and none of it maps
to anything in your repository. Accept those explicitly:

```json
{
  "sourceMaps": {
    "allowUnmappable": ["**/@vite/client", "**/@fs/**", "**/@react-refresh"]
  }
}
```

Each entry is a hole in the recording you have agreed to, so covsel names what
it let through every time it records:

```console
UNMAPPED (the run): accepted http://127.0.0.1:5173/@vite/client
  (sourceMaps.allowUnmappable); nothing they executed is recorded
```

Start with an empty list and add what the failure names. A third-party widget on
the page belongs here too.

## What fails the recording

Recording is all-or-nothing, because a partial map cannot be told from a complete
one afterwards. It fails, and writes nothing, when:

- **the suite did not pass** — a test that failed partway executed part of what
  it covers;
- **a spec file the run never reported** — a test the run does not mention cannot
  be told from a test that covered nothing, which selection reads as "no test to
  run";
- **the browser reported no coverage** — see above;
- **an executed script could not be mapped** — see above;
- **the server's inspector could not be reached**, when a server window is
  configured — an unobserved server behind a scope that claims it is exactly the
  map that skips tests;
- **a coverage dump could not be attributed**, with `coverageDir` set — more than
  one dump in a window, or one from a pid the recording was not told to track (a
  worker thread or a child process that inherited `NODE_V8_COVERAGE`); see above;
- **a test opened a further page** (a popup, or `context.newPage()`) — coverage
  cannot be attached to a page before its first scripts run, so what executed
  there is unknown rather than partly known. covsel observes the primary `page`
  only, and says so rather than crediting the test with less than it covers.

## Fail-open surface specific to UI tests

JS coverage cannot see CSS, static assets, screenshots, templates, seed data, or
external API contracts. Keep those in `sentinels` or `alwaysRun` so a change to
one runs the suite rather than passing unnoticed:

```jsonc
{
  // Both lists replace the defaults rather than adding to them, so restate
  // what you still want: the default sentinels are package.json, tsconfig*.json,
  // and every lockfile covsel recognises.
  "sentinels": [
    "package.json",
    "tsconfig*.json",
    "pnpm-lock.yaml",
    "playwright.config.*",
  ],
  "alwaysRun": ["**/*.css", "public/**"],
}
```

Global setup and teardown files belong in `sentinels` too, and so does whatever
your `webServer` command runs: a change to any of them can alter what every spec
does, in ways no coverage recording connects back to a test.

Visual-regression tests get limited wins for the same reason: what they assert on
is mostly not JavaScript.

Keep Playwright's `outputDir` (`test-results/` by default) out of the working
tree or in `.gitignore`. covsel reads an untracked directory as a change like any
other, and one outside `observes` falls open — so every selection after the first
run would be a full run.
