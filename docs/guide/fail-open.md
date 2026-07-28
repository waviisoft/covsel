# The fail-open guarantee

The catastrophic failure for a tool like covsel is _skipping a test that should
have run_. So every design tension resolves toward **over-selection**:

- New or changed test files **always run**, and so does any discovered test the
  map says nothing about — unknown coverage never reads as "covers nothing".
- Changes to **sentinel files** (`package.json`, tsconfig, lockfile, test setup)
  invalidate the map and trigger a **full run**.
- A stale, unreadable, or wrong-schema map means a **full run**, never a skipped
  one.
- A map whose recorded commit this checkout does not have, or that records no
  commit at all, means a **full run**: without that anchor there is no way to
  tell what changed since the map was recorded.
- A change to a path the recording **could not observe** means a **full run**.
  A map says which files each test covered; outside what the recorder was able
  to watch, "not covered" is a fact about where it was looking, not about what
  ran.
- Non-JS dependencies coverage can't see (fixtures, snapshots, templates) are
  handled by user-declared `alwaysRun` globs — and, later, by tracking fs reads.

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
