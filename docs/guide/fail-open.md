# The fail-open guarantee

The catastrophic failure for a tool like covsel is _skipping a test that should
have run_. So every design tension resolves toward **over-selection**:

- New or changed test files **always run**, and so does any discovered test the
  map says nothing about — unknown coverage never reads as "covers nothing".
- Changes to **sentinel files** (`package.json`, tsconfig, lockfile, test setup)
  invalidate the map and trigger a **full run**.
- Changes to **covsel's own config** trigger a **full run**, whatever your
  `sentinels` say. A map means what it means only under the config it was
  recorded with — narrowing `sourceGlobs`, for instance, stops changes outside
  the new globs counting at all, and nothing else would notice.
- A stale, unreadable, or wrong-schema map means a **full run**, never a skipped
  one.
- A map whose recorded commit this checkout does not have, or that records no
  commit at all, means a **full run**: without that anchor there is no way to
  tell what changed since the map was recorded.
- A change to a path the recording **could not observe** means a **full run**.
  A map says which files each test covered; outside what the recorder was able
  to watch, "not covered" is a fact about where it was looking, not about what
  ran.
- An executed script the recorder **cannot map back to any source** fails the
  recording, and no map is written. A bundle with no source map covers nothing
  that can be named, and an entry that credits nothing is read as a test that
  covers nothing.
- Non-JS dependencies coverage can't see (fixtures, snapshots, templates) are
  handled by user-declared `alwaysRun` globs.

> **Headline guarantee:** we never skip a test whose behavior your change could
> alter — and when we can't be sure, we run it.

## What a recording could see

Every adapter shipped today observes the code under test in the process tree it
controls, so "not covered" really does mean "did not run". That stops being true
the moment a recorder sees only part of a test's execution — a browser but not
the server behind it, one isolate of several. The map's silence about everything
else is then an artifact, and selecting on it skips tests the change breaks.

So a recorder declares what it was able to watch, and the map carries it:

```ts
const recorder: Recorder = {
  // Any repo path that ran would have been seen.
  observes: OBSERVES_EVERYTHING,
  record: (testFile) => /* … */,
};
```

The declaration is a claim about **recall**, not about what the runner happens
to execute: name a path only if code running there would have been observed.
Under-claiming costs CI minutes; over-claiming skips tests. It is required — a
map that does not say what it observed is unusable, because the only available
guess ("everything") is the one that loses tests.

The claim is not left to good faith either. The conformance suite holds every
adapter to it in both directions: nothing it records may lie outside the scope it
declares, and code inside that scope which the tests execute must appear in the
map. A recorder that watches part of a run and claims the whole one fails there
rather than shipping.

Merged shard maps keep the scope only when every shard agrees. Shards that
disagree produce a map claiming nothing, which falls open on any change, rather
than one shard's coverage vouching for paths another was never watching.

A recorder with several observation windows onto one test — a browser, and the
server behind it — combines them into a single entry, and that entry claims the
**union** of what its windows could see. The opposite of the shard rule, from the
same invariant: no entry may be vouched for by a scope that was not watching that
entry's execution. Shards observe different entries, so one shard's scope may not
speak for another's; windows observe the same execution, and the entry carries
all of them. A window that produced nothing usable fails the recording instead of
contributing half a test.

What a recording reports about its windows can only ever **narrow** the
recorder's declaration — entries watched by different sets of windows leave the
map claiming nothing, which falls open. A unit claiming a path its recorder said
it could not see fails the recording: that contradiction resolved the other way
turns a recorder's own admission that it is blind somewhere into a map asserting
it was watching.

## A script that cannot be mapped

This rule belongs to the recorders that observe raw V8 coverage — the generic
`NODE_V8_COVERAGE` wrap, and anything built on covsel's V8 mapper. Adapters that
read their runner's own already-source-mapped coverage (Vitest, Jest) never see
a bundled script in the first place, so it does not arise for them.

Coverage against a bundle is not coverage of anything anyone wrote. If the
build published no source map, there is no way back to the sources behind it,
and the honest answer is that the recording failed — not that those tests cover
nothing. This is reachable from a stock bundler setup: `vite build` emits no
source map unless you ask for one, and `sourcemap: 'hidden'` writes the map but
strips the comment pointing at it. Recording against such a build used to
produce entries that existed and credited nothing, so editing the file every
test executes selected zero tests.

So a script that executed and resolves to no source in your repository fails the
recording, naming the script, and no map is written. covsel looks for the map in
every place a build publishes one: a `sourceMappingURL` comment naming a sidecar
file, the same comment carrying the map inline as a `data:` URI, the
conventional `<script>.map` neighbour when the comment was stripped, over HTTP
for scripts a browser loaded from a dev server, and in a build directory the
served URLs are mapped onto.

A source map is followed only as far as it can be trusted. A map read from disk
places its sources exactly, relative to itself. A map fetched over HTTP has no
such anchor, so covsel confirms each source against the text the build published
in `sourcesContent` before crediting it — a served path that merely matches a
same-named file in your repository is a guess, and crediting the wrong file
loses every change to the right one. A source that cannot be confirmed, or that
should be in your repository but is not where the map says, fails the recording
along with a map that has none at all.

Not everything that fails to map is a hole. Your own files are their own
sources; vendored code under `node_modules` is covered by the lockfile sentinel
rather than by coverage; and the runtime's own scripts are not your project's
code. What fails is code built from this repository and handed back to the
runner with no way to trace it home. In a workspace that means a sibling
package consumed as `packages/*/dist/*.js` needs source maps too — the tests
importing it reach your code only through that build.

Scripts that will genuinely never be mappable — a third-party widget on the page
under test — can be accepted with `sourceMaps.allowUnmappable`. Each entry is a
gap in the recording that you have chosen to accept, so `covsel record` names
the scripts it let through every time it lets one through.

## A map recorded from a dirty tree

A map is trusted for the commit it names, and the comparison against that commit
is exact. So a map may only name a commit it genuinely describes — which means
recording from a working tree with uncommitted changes produces a map with **no
commit at all**:

```
covsel record: wrote 12 entries to /repo/.covsel/map.json
covsel record: recorded from a tree with uncommitted changes, so the map is not
anchored to a commit -- selection will fall open to a full run until you commit
and re-record.
```

The alternative is worse than it looks. Stamping `HEAD` on such a map passes every
guard covsel has: the commit exists, and once the edits are reverted the tree
matches it exactly, so the diff is empty and the map is fully trusted — for a tree
it never described. Coverage the edited tree did not execute is then missing from
a map that `covsel status` reports as healthy, and the test that needed it is
skipped.

Recording while you are mid-edit is the normal local case, so this is not an
error: the map is still written, still serves `status`, and selection falls open
loudly until a recording from a committed tree replaces it. `covsel watch
--record` declines to re-record while the tree is dirty for the same reason, so
the loop refreshes the map at each commit rather than at each save. In CI it never
comes up — a fresh checkout is clean.

The tree is checked **before** the suite runs, not after, because the question is
what tree the recording was taken against. That matters if your tests write
anything into the repository — a snapshot created on first run, a report, a log —
since such a suite leaves the tree dirty by the end through no fault of your
sources. Checking afterwards would leave those projects permanently unanchored and
always falling open, which would look exactly like covsel not working.

## How the map enforces it

The persisted map is a **versioned contract**. Bumping the schema version
invalidates every stored map, which — by this same policy — forces a full run
with a clear log line rather than trusting stale data.

The `isUsableMap` guard in `@covsel/core` encodes the rule directly: anything it
does not positively recognize as a current, well-formed map is treated as "run
everything."

```ts
import { isUsableMap } from '@covsel/core';

// A false result must mean "run every test", never "run none".
if (!isUsableMap(loaded)) {
  runFullSuite();
}
```

This is the difference between a toy and something a team trusts in CI: the
failure mode is _wasted CI minutes_, never _a real regression that shipped
green_.

## In watch mode

A long-running loop has one extra way to fail: it can keep looking healthy while
selecting nothing. [Watch mode](/guide/watch) is built so it cannot. Change
events decide only _when_ to select, never _what_ — every batch re-runs the same
full selection against the git diff, so a coalesced, renamed, or unnamed event
still gets a complete answer. Selection that cannot be computed falls open to a
full run with the reason printed, every time and not just the first. A failing
test run leaves the watcher alive. And a watcher that dies stops the loop with a
non-zero exit rather than sitting idle, because a watcher that sees no changes
cannot select anything.
