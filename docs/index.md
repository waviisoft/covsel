---
layout: home

hero:
  name: covsel
  text: Run only the tests your diff can affect
  tagline: >-
    Runtime-coverage test impact analysis for any JS/TS runner — precise where
    static import-graph selection lies, and the only option for runners that
    have no selection at all.
  actions:
    - theme: brand
      text: What is covsel?
      link: /guide/what-is-covsel
    - theme: alt
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/waviisoft/covsel

features:
  - title: Sees what actually ran
    details: >-
      Watches which source each test executes via V8 coverage, instead of
      guessing from the static import graph — which lies on dynamic imports,
      runtime config, and DI/plugin coupling.
  - title: Works with any runner
    details: >-
      It depends only on the two things every JS/TS runner shares: V8 can
      observe the code, and every runner accepts a list of test files. Vitest,
      Jest, Mocha, node:test, cucumber-js, Playwright.
  - title: Fails open, loudly
    details: >-
      The catastrophic failure is skipping a test that should have run. Every
      design tension resolves toward over-selection — new tests always run,
      sentinel changes trigger a full run, a stale map means a full run.
---

::: warning Status: pre-alpha
The map schema, layer interfaces, and CLI shell exist; selection is in progress.
See the [roadmap](/guide/roadmap).
:::
