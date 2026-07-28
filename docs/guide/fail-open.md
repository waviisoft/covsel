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
- Non-JS dependencies coverage can't see (fixtures, snapshots, templates) are
  handled by user-declared `alwaysRun` globs — and, later, by tracking fs reads.

> **Headline guarantee:** we never skip a test whose behavior your change could
> alter — and when we can't be sure, we run it.

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
