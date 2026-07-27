# Writing an adapter

Adapters are the community contribution lane. An adapter teaches covsel how to
observe one runner and how to hand a selection back to it — nothing else. The
map schema, the selector, and the fail-open policy are shared, so an adapter
cannot get selection subtly wrong on its own.

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

| Check                               | What it protects                                 |
| ----------------------------------- | ------------------------------------------------ |
| `formatSelection` deduplicates      | the runner receives each file once               |
| records a usable map                | the adapter produces something selection can use |
| attributes each unit to what it ran | no cross-contamination between tests             |
| records the same coverage twice     | recording is deterministic                       |
| editing one source selects its unit | selection is precise, not "everything"           |
| a test added after recording runs   | new tests are never skipped                      |
| a sentinel change runs everything   | config changes invalidate the map                |
| an unusable map runs everything     | a stale map never means "run nothing"            |

With Vitest, one call registers each check as its own test:

```ts
import { describeAdapterConformance } from '@covsel/conformance/vitest';

describeAdapterConformance({
  adapter: myAdapter,
  createRecorder: ({ cwd, config }) =>
    createMyRecorder({ command: ['my-runner'], cwd, config }),
  fixture: {
    command: ['my-runner'],
    files: {/* two tests executing different sources */},
    units: {
      a: { testFile: 'test/a.test.js', source: 'src/a.js' },
      b: { testFile: 'test/b.test.js', source: 'src/b.js' },
    },
    newTest: { file: 'test/c.test.js', contents: '/* … */' },
  },
});
```

The fixture is yours because projects differ per runner; the assertions are not.
If both units live in the same file — scenarios in a feature, tests in a suite —
give each a `name`, and the precision checks will hold the adapter to per-test
selection instead of file level.

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
