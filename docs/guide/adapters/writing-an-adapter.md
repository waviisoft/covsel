# Writing an adapter

Adapters are the community contribution lane. An adapter teaches covsel how to
observe one runner and how to hand a selection back to it -- nothing else. The
map schema, the selector, and the fail-open policy are shared, so most of what
could go wrong is already decided for you.

What stays yours is the part no shared layer can check: whether the coverage you
record is everything a test touched, and whether the invocation you build really
runs what the selection names. Miss a source and covsel will confidently skip a
test that needed to run -- the one failure this project exists to prevent. That is
what the conformance kit is for.

## What an adapter is

**One object satisfying `Adapter` from `@covsel/core`.** That object is the whole
contract: covsel resolves `--adapter <name>` to it and asks it for everything it
needs, so there is nothing else to register anywhere.

```ts
import type { Adapter, Recorder, RecorderInit, TestId } from '@covsel/core';

export const myAdapter: Adapter = {
  name: 'my-runner',
  formatSelection: (tests: TestId[]): string[] => [...new Set(tests.map((t) => t.file))],
  createRecorder: (init: RecorderInit): Recorder => createMyRecorder(init),
};
```

Two capabilities are required:

1. **`formatSelection(tests)`** -- selected test ids as the runner's input. At
   file level that is a deduplicated file list, which is what `covsel affected`
   prints and what `covsel run` appends to your command.
2. **`createRecorder({ command, cwd, config })`** -- a `Recorder` that returns
   one `RecordedUnit` per test it observed: a single whole-file unit, or one unit
   per individual test for runners you can hook per test. It also declares
   `observes`, the globs it is able to see execution within.

   A recorder records one of two ways, and implements exactly one of them:

   - **`record(testFile)`** drives the runner once per test file. Right when a
     process per file is cheap, which it is for every runner covsel ships an
     adapter for.
   - **`recordRun(testFiles)`** drives the runner once for the whole suite and
     returns the units for all of it. For a runner whose startup cost is paid per
     invocation -- a browser, an application server -- paying it per file turns
     recording into something nobody runs twice.

   Recording reconciles a whole-run recorder's units against the files it asked
   for, and a file the run never reported fails the recording: a test file
   missing from the report cannot be told apart from one that covers nothing, and
   covering nothing means never being selected again. Report the units with the
   same repo-relative paths covsel asked about, or every file looks unreported.

Two more are optional, and omitting one means "covsel's default is right for my
runner":

3. **`runSelection({ selected, command, cwd })`** -- if the runner can be told to
   run individual tests (a name filter, a tag, a `file:line`), turn a selection
   into that invocation and return its exit code. Without one, covsel appends
   `formatSelection`'s file list to the command instead. When the filter is a
   single regex over test names -- node:test's `--test-name-pattern`, Mocha's
   `--grep`, cucumber's `--name` -- build it with `testNamePattern` from
   `@covsel/core`, which escapes and anchors the names. Hand-rolling it is how a
   test called `a+b (finally)` becomes a valid pattern that matches nothing, and
   the run then passes having executed none of the affected tests.
4. **`defaultTestGlobs`** -- how to discover tests when the project has not set
   `testGlobs`. Only needed when your runner's tests are not `*.test.*` sources;
   cucumber's are `.feature` files, so its adapter supplies `['**/*.feature']`.

The compiler holds you to `formatSelection` and `createRecorder`: a missing one
is an error in your own package's build, not something a reviewer has to spot.
Which way a recorder records is a runtime question rather than a type-level one,
since it implements one of two optional methods -- a recorder offering neither
compiles, and `covsel record` refuses it, naming it as an adapter bug.

How you get coverage is your choice, and it is the only genuinely
runner-specific decision:

- Runners that execute your source directly can use the shared
  `NODE_V8_COVERAGE` process observer.
- Runners that transform sources first (Vitest, Jest) must read the runner's own
  coverage, because process coverage never sees the original files.
- Runners with lifecycle hooks can drive the `InspectorObserver` per test.

### Mapping inside a runner you spawned

The third mechanism usually means a shim: your recorder starts the runner, and
the observer and mapper live in that process rather than yours. The mapper then
needs the project's configuration, and it has to travel — which is where an
adapter loses settings its user did set.

Send `toMapperConfig(config)` and build the mapper from what arrives, rather
than picking fields by hand:

```ts
// In the recorder, on the way out:
COVSEL_CONFIG: JSON.stringify(toMapperConfig(init.config));

// In the shim, on the way in:
const config = JSON.parse(process.env.COVSEL_CONFIG ?? '{}');
const mapper = new V8FileMapper({ cwd: process.cwd(), config });
```

`MapperConfig` is what the mapper reads, and `toMapperConfig` narrows to exactly
that. A hand-picked subset fails quietly in one direction: a mapper given no
`sourceMaps` behaves precisely like one whose project configured none, so a
project that has accepted an unmappable script watches its recording fail with
nothing to say why.

If your mapper can accept scripts under `sourceMaps.allowUnmappable`, report
them: implement the optional `unmappableAllowed()`, returning what the last
`record` let through — `mapper.takeAllowedUnmappable()` collects it, and a shim
sends it back alongside its units. Each accepted script is coverage the map is
missing, and `covsel record` says so on every recording that let one through.

## Say what you can see

`observes` is the other half of what you record, and the half no shared layer can
infer. It declares the repo paths where, had code run, your recorder would have
seen it — so a change outside them falls open to a full run instead of trusting
a silence that means nothing.

All three mechanisms above watch the code under test in the process tree the
recorder controls, so they declare `OBSERVES_EVERYTHING`:

```ts
return {
  observes: OBSERVES_EVERYTHING,
  async record(testFile) {
    /* … */
  },
};
```

Declare something narrower the moment your recorder sees only part of a test's
execution. A recorder that collects coverage from a browser sees the app's
sources and nothing of the server the page talks to; claiming everything there
would let a change to that server skip the tests it breaks. Under-claiming costs
CI minutes, over-claiming costs correctness — so when in doubt, claim less.

One boundary this cannot express: paths say _where in the repo_, not _in which
process_. A recorder tied to a single isolate will not see a test that shells out
to another one, and no glob describes that. If your runner works that way, say so
in the adapter's docs.

The declaration is not taken on trust: the conformance kit holds it in both
directions. Nothing you record may lie outside it, and anything inside it that
the fixture's units execute must appear in the map -- so a recorder that watches
part of the run and claims the whole one is caught rather than certified.

## Say whether you can see dependencies

`observesPackages` is a separate claim, and one `observes` cannot make: `**`
already matches every `node_modules` path, so no scope distinguishes a recorder
that watches vendored code from one that never sees it. Declare it only when,
had a test executed any package's code anywhere, you would have seen it —
including code that ran while the module graph was being evaluated.

```ts
// `toPackages` is on `V8FileMapper`, not on the `Mapper` interface: it reads
// raw V8 script URLs and their source maps, which is not something every
// mapper has to be able to do.
const mapper = new V8FileMapper({ cwd, config: toMapperConfig(config) });

return {
  observes: OBSERVES_EVERYTHING,
  observesPackages: true,
  async record(testFile) {
    const raw = await observer.endTest({ file: testFile });
    return [
      {
        test: { file: testFile },
        files,
        blocks,
        packages: await mapper.toPackages(raw),
      },
    ];
  },
};
```

Most recorders should leave it off, and three shapes must:

- **A runner's own coverage provider.** `@vitest/coverage-v8` and Jest both drop
  `node_modules` before covsel is handed anything, so an adapter reading their
  report sees no vendored code at all however much of it ran.
- **A per-test window opened in a hook.** `beforeEach` runs after the test
  file's imports have evaluated, so a dependency imported for its side effects,
  or imported but never called inside the window, is invisible.
- **A recorder wrapping a command nobody vouched for.** The dump above holds
  every script the process tree loaded — but only that tree. A command that
  drives a browser, shells out to another runtime, or runs its tests in a
  container arrives as the same opaque argv as `node --test`, and nothing about
  it can be read off the command name or off the dump: vendored code appearing in
  the dump is equally consistent with having missed every package that ran
  elsewhere. So `createGenericRecorder` takes the assertion as an input,
  `runsInNodeProcessTree`, and the generic adapter never makes it.

  Vouching is about the run, never about the runner. Your runner executing its
  own sources directly is not the question — any runner can be pointed at a spec
  that drives a browser — so an adapter that sets it for every project using it
  has made the guess the input exists to refuse. Only someone who knows the suite
  a command names can say it executes nothing outside the process tree.

Declaring it commits you to setting `packages` on every unit — an empty array
included, since `[]` is the measurement "this test ran no vendored code" and
absence is "nobody was watching". Recording **fails** a declaring recorder whose
unit omits them, because there is no safe way to guess what it ran. The reverse
is only declined: a unit reporting packages its recorder has not claimed to
watch has them dropped, and the map keeps none. That matters if you wrap another
recorder and forward its units under your own narrower declaration — you lose
the feature, not the recording.

A recorder combining several windows declares it only when every window can see
packages; the windows union, and one blind window would under-credit the unit.

## When one window is not the whole test

A recorder that spans several isolates -- a browser, the worker driving the spec,
the server the page talks to -- holds one observation per isolate, and none of
them is the test. Fold them with `combineObservations`, so the rules are decided
once rather than re-derived per adapter:

```ts
import { combineObservations, unionScopes, type ObservationWindow } from '@covsel/core';

const windows: ObservationWindow[] = [
  { observes: ['src/**'], files: browserFiles, blocks: browserBlocks },
  { observes: ['server/**'], files: serverFiles, blocks: serverBlocks },
];

return [combineObservations({ file: testFile }, windows)];
```

Covered files union by path, blocks deduplicate by file and hash, and the unit
claims the union of what its windows claimed -- `src/**` and `server/**`, never
`**` and never some wider glob that happens to cover both.

**Your recorder declares that same union**, because the map is stamped with what
the units reported and covsel refuses a unit claiming anything the recorder did
not:

```ts
const scopes = [['src/**'], ['server/**']];

return {
  observes: unionScopes(scopes),
  async record(testFile) {
    /* … */
  },
};
```

Reporting per-unit scopes lets a recording be held to _less_ than the
declaration, which is what it is for: a spec that never opened a page was watched
by the server window alone, and its entry must not be vouched for by a scope
covering the browser too. When units disagree, the map claims nothing and every
change falls open. What they cannot do is claim more -- a recorder that declares
`src/**` while its windows claim `server/**` fails the recording rather than
producing a map asserting it watched a server it is blind to.

Opening and closing the windows stays yours: only the code that started them can
stop them around the same execution. Two rules come with that.

**A window that produced nothing usable fails the unit.** Hand it in as a
failure and let the error propagate -- recording that test file fails and no map
is written:

```ts
const server: ObservationWindow = coverage
  ? { observes: ['server/**'], files, blocks }
  : { failed: 'the app server reported no coverage' };
```

Half a test's execution recorded as all of it is precisely the map that skips
tests: everything the failed window would have covered reads as "ran nowhere".

**A window may claim a path only if it would see that path run wherever the test
runs it.** Scopes union, so a path claimed by the browser window but executed
inside the server's isolate ends up recorded as covered by a recording that never
watched it. Code both sides can execute -- anything isomorphic -- must be claimed
by both windows or by neither. When the layout is the user's to describe, take
the scope from your adapter's configuration and document that this is what they
are promising.

## Prove it with the conformance kit

Every adapter must pass the shared suite in `@covsel/conformance`. It writes a
throwaway project, records it, edits it, and checks the behaviour that matters --
including the fail-open rules, which are the ones nobody should have to
re-derive:

| Check                                | What it protects                                       |
| ------------------------------------ | ------------------------------------------------------ |
| `formatSelection` deduplicates       | the runner receives each file once                     |
| records a usable map                 | the adapter produces something selection can use       |
| attributes each unit to what it ran  | no cross-contamination between tests                   |
| records the same coverage twice      | recording is deterministic                             |
| editing one source selects its unit  | selection is precise, not "everything"                 |
| editing a shared source selects both | **coverage follows imports, not just what tests name** |
| editing a function body selects it   | **blocks are real, not just module skeletons**         |
| a selection runs the units it names  | **the invocation honours the selection**               |
| a test added after recording runs    | new tests are never skipped                            |
| a sentinel change runs everything    | a change covsel cannot attribute invalidates the map   |
| an unusable map runs everything      | a stale map never means "run nothing"                  |
| blind spots fall open                | **a partial view is declared, never assumed**          |

The four in bold catch an adapter that is silently wrong rather than obviously
broken. Each corresponds to a real way to be green and useless: recording only
what a test file names, recording only module skeletons so every change inside a
function is invisible, building an invocation that runs zero tests and still
reports success, and recording a plausible fraction of what a test executed
because the recorder was never watching the rest. Nothing else in the suite
notices any of them -- the fail-open checks pass
because core's policy holds regardless of what the adapter recorded, and the
precision checks pass because under-recording is, if anything, _more_ precise.

You hand it your adapter and a project to exercise it on -- nothing else. The
suite builds your recorder and runs every selection through the same core
dispatch `covsel run` uses, so passing here means the invocation covsel really
builds works, not one the suite assembled to look like it.

With Vitest, one call registers each check as its own test:

```ts
import { describeAdapterConformance, RAN_MARKER_FILE } from '@covsel/conformance/vitest';

describeAdapterConformance({
  adapter: myAdapter,
  fixture: {
    command: ['my-runner'],
    files: {/* see the five rules below */},
    units: {
      a: {
        testFile: 'test/a.test.js',
        source: 'src/a.js',
        bodyEdit: { find: 'shared(x * 2)', replace: 'shared(x * 3)' },
      },
      b: {
        testFile: 'test/b.test.js',
        source: 'src/b.js',
        bodyEdit: { find: 'shared(x + 1)', replace: 'shared(x + 2)' },
      },
    },
    sharedSource: 'src/shared.js',
    newTest: { file: 'test/c.test.js', contents: '/* ... */' },
  },
});
```

The fixture is yours because projects differ per runner; the assertions are not.
Five rules make it work, and the suite enforces the ones it can:

- **Two units executing different sources**, so precision is observable.
- **One `sharedSource` both units reach _through_ their own sources** -- no test
  file may name it. The indirection is the whole point: a recorder that credits a
  test with the files its test file imports, and nothing those reach in turn,
  looks flawless against a directly-imported shared source and still skips tests
  in a real project. The suite rejects a fixture whose test files mention the
  shared source, so this cannot be satisfied on paper.
- **A `bodyEdit` per unit** naming a change inside a function body. Appending to a
  file only perturbs the module skeleton, so without this the block-granularity
  path -- the default -- never runs. The suite rejects a `bodyEdit` that changes the
  module block or leaves every function hash intact.
- **A `blindSpot` when your recorder declares less than everything.** A source
  both units execute that lies _outside_ the scope you declare -- the app server a
  browser test drives, an isolate the runner starts on its own -- plus a
  `breakingEdit`, a change to it that makes both units fail. The suite proves it
  by difference: it runs both units whole and requires them to pass, applies the
  edit, and requires the run to fail. A blind spot they still pass without is
  code nothing reaches, and it is rejected rather than certifying a fall-open
  nothing exercised. The same edit is then the diff selection must report a full
  run for, naming the file. A declaration narrower than the whole repo with
  nothing outside it for the units to execute is refused rather than passed --
  the question is asked of the declaration, not of your file list, so an asset no
  unit executes neither demands a blind spot nor stands in for one. An adapter
  declaring `OBSERVES_EVERYTHING` needs none, since nothing lies outside `**`;
  supply one anyway -- the shipped adapters all do -- and the suite holds the
  recorder to having recorded it, which is what catches a recorder that sees part
  of a run and claims the whole one.
- **Every unit appends its own label** -- its `name`, or its `testFile` when it has
  none -- plus a newline to `RAN_MARKER_FILE` when it runs. That is how the suite
  sees which units a selection actually executed, without parsing any runner's
  output format. A fixture that forgets fails rather than passing quietly, because
  the suite first selects _both_ units and requires both labels to appear.

If both units live in the same file -- scenarios in a feature, tests in a suite --
give each a `name`, and give your adapter a `runSelection`. The precision checks
then hold the adapter to per-test selection instead of file level, and the suite
verifies the runner really does narrow the run rather than reporting success on
zero tests.

Not using Vitest? `runAdapterConformance(spec)` returns a plain report you can
assert on from any framework:

```ts
const results = await runAdapterConformance(spec);
const failures = results.filter((r) => !r.ok);
```

Two more knobs cover real projects: `nodeModulesFrom` links an existing
`node_modules` into the fixture when your runner needs dependencies, and
`config` overrides covsel settings for the fixture project. Test discovery needs
neither -- an adapter's own `defaultTestGlobs` are applied here exactly as the CLI
applies them, so a runner whose tests are `.feature` files is discovered with no
fixture configuration at all.

## Publishing it

covsel resolves an adapter it does not ship from the project that installed it,
so a published package is selectable with no change to covsel. Two things make
yours findable:

- **Name the package `covsel-adapter-<runner>`** (or `@your-scope/covsel-adapter-<runner>`).
  `--adapter <runner>` expands to `@covsel/adapter-<runner>` and then
  `covsel-adapter-<runner>`, so the short name works out of the box. A package
  named anything else is still selectable -- users write the full specifier -- but
  the short name is what people will reach for.
- **Export it as `adapter`**, or as the default export:

  ```ts
  export const adapter: Adapter = myAdapter;
  ```

covsel checks what it imported against the contract before recording anything,
and rejects a module that does not satisfy it by naming the capability that
failed. If your package exports something else -- a factory, a config object -- it
will be refused rather than half-used. The check is strict for a fail-open
reason: an adapter that loads but cannot really drive its runner would record
that its tests cover nothing, and covsel would then skip them on every diff.

## Conventions

Adapters depend on `@covsel/core` only -- never on each other or on CLI
internals. Keep the runner-specific part as small as it can be: everything you
push into the adapter is something the shared layers can no longer guarantee.
