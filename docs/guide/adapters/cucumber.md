# cucumber-js adapter

`@covsel/adapter-cucumber` brings **scenario-level** selection to
[cucumber-js](https://github.com/cucumber/cucumber-js) — a runner with no
built-in test selection at all. Instead of running a whole feature file (or the
whole suite), covsel records what each scenario executes and runs only the
scenarios a change can affect.

## How it records

Recording loads a support-code shim through cucumber's own `--import`. The shim
wraps every scenario with the per-scenario inspector observer, snapshotting V8
precise coverage in `Before` and diffing it in `After`, so each scenario becomes
its own map entry.

Two details are worth knowing:

- Hooks have to be registered while cucumber is loading support code, so the
  shim must go through cucumber's `--import` — a plain `node --import` preload is
  rejected because cucumber's support-code builder is not running yet.
- `--import` on the command line **replaces** cucumber's default support-code
  discovery, so the adapter also re-supplies the conventional glob for the
  feature's directory. A project that declares `import` in its cucumber config
  keeps working, because the CLI flag and the config are merged.

Step definitions are themselves code the scenario executes, so they are recorded
like any other source: editing a step definition re-runs every scenario that
used it.

## Setup

Install cucumber-js as usual — there is nothing extra to add:

```bash
npm install -D @cucumber/cucumber
```

Feature files are discovered automatically (`**/*.feature`) when you pass
`--adapter cucumber`; set `testGlobs` in your covsel config only if your features
live somewhere unusual.

## Record → affected → run

```bash
# Build the map, one entry per scenario
covsel record --adapter cucumber -- cucumber-js

# Print the feature files the diff can affect
covsel affected --adapter cucumber

# Run only the affected scenarios
covsel run --adapter cucumber -- cucumber-js
```

`covsel run` invokes cucumber over the affected feature files with a `--name`
pattern matching the affected scenario names. Duplicate scenario names and
scenario outlines only ever cause _more_ scenarios to run, so selection stays
fail-open. Feature files that must run in full — a new or changed `.feature` —
are run without a name filter.

A runnable end-to-end example lives in
[`examples/cucumber-basic`](https://github.com/waviisoft/covsel/tree/main/examples/cucumber-basic).
