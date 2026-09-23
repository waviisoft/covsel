---
'@covsel/core': minor
'@covsel/adapter-playwright': minor
---

Block-level server coverage, for a server started with `NODE_V8_COVERAGE`.

The Playwright adapter's server window and `InspectorObserver` could only ever
see block granularity for code a server loaded _during_ a test's own window.
Anything imported at boot — which for a typical server is nearly every route
and page module — kept only file granularity, because coverage collection
started fresh with each test and had no way to tell an un-run function from
one nobody had ever tracked.

Start the server with `NODE_V8_COVERAGE` pointed at a directory (alongside
`--inspect`, still), and pass the same directory as `coverageDir`:

```ts
export const test = base.extend(
  covselFixtures({
    browser: { observes: ['src/**'] },
    server: {
      observes: ['server/**'],
      inspectUrl: 'http://127.0.0.1:9229',
      coverageDir: '/abs/path/to/.covsel/server-cov',
    },
  }),
);
```

V8 then collects precise coverage from the moment the process starts, so the
first dump — taken before the first test — sees every function boot loaded,
including the ones that never ran, at a real zero count. That "boot" delta is
merged into every later test's own delta, keeping block granularity for
boot-loaded code the same way it already worked for code loaded on demand.
Leaving `coverageDir` unset keeps today's behavior: a session opened fresh
inside each test, file-granular for anything loaded at boot.

`InspectorObserver` picks the same mechanism up automatically, from
`process.env.NODE_V8_COVERAGE` on the process it is observing, with no
config: set the env var on a `covsel record` invocation and it takes the boot
dump before the first `startTest()` instead of diffing per-test CDP
snapshots.

A dump this cannot attribute to the tracked process's own main thread alone —
a worker thread or a child process that inherited `NODE_V8_COVERAGE`, or two
overlapping windows — fails the recording rather than guessing which test it
belongs to, the same standard the per-test session already held itself to.
