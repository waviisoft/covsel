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
observes **the browser** and nothing else.

That is not a gap covsel hides. The scope you declare in `observes` is written
into the map, and every change outside it forces a full run rather than being
read as code no test covers:

```console
$ covsel affected
covsel: full run -- server/api.ts changed, which the recording could not observe
```

So you get real selection on client changes, and no opinion at all about the
rest. The trade is explicit, and it is the reason `observes` has no default:

```json
{
  "adapter": "playwright",
  "observes": ["src/**"]
}
```

Declare a path only when, had code there run, the browser recording would have
seen it. **Under-claiming costs CI minutes; over-claiming skips tests.** Scope
globs are matched strictly — no basename widening — because a path wrongly
counted as observed suppresses the full run it should have caused. Without
`observes`, `covsel record` refuses to start rather than guess.

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

Against a minified production bundle, selection degrades toward file level:
code inlined into several callers cannot be called idle by a range that never
ran, so covsel keeps those blocks marked executed. That is the safe direction,
and it is why the dev server is the route to record against.

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
