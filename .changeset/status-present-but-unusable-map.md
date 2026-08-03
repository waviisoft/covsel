---
'@covsel/core': minor
'covsel': minor
---

Tell a map covsel cannot use apart from one that is not there, in `covsel
status`.

`LocalStore.read()` returns `undefined` for a map that is missing, unparseable,
or recorded under a schema this build does not read, and `computeStatus`
collapsed all three into `exists: false`. So `status` printed the path of the map
file and then said it did not exist, and the reason field under `next:` was empty
because the missing-map branch returned before anything set it. The reader was
sent to look for a file sitting exactly where covsel had just said it was, with
no hint that re-recording was the fix.

Selection was never wrong here: an unusable map falls open to a full run, which
is what it should do. The collapsing is right for selection — a caller deciding
what to run must not care _why_ a map cannot be believed — so the distinction is
drawn beside it rather than inside it.

- `LocalStore.inspect()` is the diagnostic read: `absent`, `unusable` with the
  reason, or `usable` with the map. `read()` is now defined as "`inspect()`,
  usable or nothing", so the selection path is unchanged and the two cannot come
  to disagree about usability.
- `mapRejection(value)` in `@covsel/core` says why a stored value is not a usable
  map, or `undefined` when it is one, and `isUsableMap` is defined as
  `mapRejection(value) === undefined`. One place decides usability; the reasons
  are a rendering of that decision rather than a second opinion that could drift
  from it.
- `StatusResult.exists: boolean` is replaced by `mapState: 'absent' | 'unusable'
| 'usable'` plus an optional `unusableReason`. **This is the breaking part** for
  anything reading `computeStatus` directly: `exists === true` becomes
  `mapState === 'usable'`. The boolean could not express the case that caused the
  bug, which is why it is gone rather than kept alongside.
- `fullRunReason` takes the map as `unknown`. Its "recorded map is stale or has
  an incompatible schema" branch was unreachable while the parameter was typed as
  a `CoverageMap`, which is exactly the wording a caller holding a rejected map
  needs.
- `covsel status` prints `exists: yes, but not usable (schema v2, covsel reads v3
-- re-record)`, and gives a reason under `next:` in every case rather than
  falling back to a generic "map cannot be trusted". The recorded-at, granularity
  and entry lines are still printed only for a map that parsed.
