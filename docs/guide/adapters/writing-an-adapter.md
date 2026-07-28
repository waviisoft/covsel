# Writing an adapter

Adapters are the community contribution lane. An adapter teaches covsel how to
observe one runner and how to hand a selection back to it — nothing else. The
map schema, the selector, and the fail-open policy are shared, so most of what
could go wrong is already decided for you.

What stays yours is the part no shared layer can check: whether the coverage you
record is everything a test touched, and whether the invocation you build really
runs what the selection names. Miss a source and covsel will confidently skip a
test that needed to run — the one failure this project exists to prevent. That is
what the conformance kit is for.

## What an adapter provides

1. **An `Adapter`** — a name, and `formatSelection(tests)` turning selected test
   ids into the runner's input. At file level that is a deduplicated file list.
2. **A `Recorder`** — `record(testFile)` returning one `RecordedUnit` per test it
   observed: a single whole-file unit, or one unit per individual test for
   runners you can hook per test.
3. **Optionally, a run plan** — if the runner can be told to run individual
   tests (a name filter, a tag, a `file:line`), a function that turns a selection
   into that invocation. Without one, covsel passes the file list.

How you get coverage is your choice, and it is the only genuinely
runner-specific decision:

- Runners that execute your source directly can use the shared
  `NODE_V8_COVERAGE` process observer.
- Runners that transform sources first (Vitest, Jest) must read the runner's own
  coverage, because process coverage never sees the original files.
- Runners with lifecycle hooks can drive the `InspectorObserver` per test.

## Prove it with the conformance kit

Every adapter must pass the shared suite in `@covsel/conformance`. It writes a
throwaway project, records it, edits it, and checks the behaviour that matters —
including the fail-open rules, which are the ones nobody should have to
re-derive:

| Check                                | What it protects                                      |
| ------------------------------------ | ----------------------------------------------------- |
| `formatSelection` deduplicates       | the runner receives each file once                    |
| records a usable map                 | the adapter produces something selection can use      |
| attributes each unit to what it ran  | **no source goes unrecorded**, no cross-contamination |
| records the same coverage twice      | recording is deterministic                            |
| editing one source selects its unit  | selection is precise, not "everything"                |
| editing a shared source selects both | **coverage is complete, not just the obvious part**   |
| a selection runs the units it names  | **the invocation honours the selection**              |
| a test added after recording runs    | new tests are never skipped                           |
| a sentinel change runs everything    | config changes invalidate the map                     |
| an unusable map runs everything      | a stale map never means "run nothing"                 |

The three in bold are the ones that catch an adapter that is silently wrong
rather than obviously broken.

With Vitest, one call registers each check as its own test:

```ts
import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

describeAdapterConformance({
  adapter: myAdapter,
  createRecorder: ({ cwd, config }) =>
    createMyRecorder({ command: ['my-runner'], cwd, config }),
  // Only if your runner can narrow a run below file level.
  runSelection: ({ selected, cwd }) =>
    runMySelection({ command: ['my-runner'], selected, cwd }),
  fixture: {
    command: ['my-runner'],
    files: {/* two tests, each executing its own source and one shared source */},
    units: {
      a: { testFile: 'test/a.test.js', source: 'src/a.js' },
      b: { testFile: 'test/b.test.js', source: 'src/b.js' },
    },
    sharedSource: 'src/shared.js',
    newTest: { file: 'test/c.test.js', contents: '/* … */' },
  },
});
```

The fixture is yours because projects differ per runner; the assertions are not.
Three rules make it work:

- **Two units executing different sources**, so precision is observable.
- **One `sharedSource` both units execute**, so recall is observable. Without it
  a recorder that only credits directly-imported files looks perfect, right up
  until it skips a test.
- **Every unit appends its own label** — its `name`, or its `testFile` when it has
  none — plus a newline to `RAN_MARKER_FILE` when it runs. That is how the suite
  sees which units a selection actually executed, without parsing any runner's
  output format.

If both units live in the same file — scenarios in a feature, tests in a suite —
give each a `name` and supply `runSelection`. The precision checks then hold the
adapter to per-test selection instead of file level, and the suite verifies the
runner really does narrow the run rather than reporting success on zero tests.

Not using Vitest? `runAdapterConformance(spec)` returns a plain report you can
assert on from any framework:

```ts
const results = await runAdapterConformance(spec);
const failures = results.filter((r) => !r.ok);
```

Two more knobs cover real projects: `nodeModulesFrom` links an existing
`node_modules` into the fixture when your runner needs dependencies, and
`config` overrides covsel settings such as `testGlobs` when the runner's tests
are not `*.test.*` files.

## Conventions

Adapters depend on `@covsel/core` only — never on each other or on CLI
internals. Keep the runner-specific part as small as it can be: everything you
push into the adapter is something the shared layers can no longer guarantee.
