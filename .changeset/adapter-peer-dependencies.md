---
'@covsel/adapter-vitest': minor
'@covsel/adapter-jest': minor
'@covsel/adapter-cucumber': minor
---

Declare the runner each adapter drives as a peer dependency. An adapter shells
out to its runner and reads the coverage that run produces, so the runner is a
hard requirement it was asserting only in prose: `@covsel/adapter-vitest` needs
`vitest` and `@vitest/coverage-v8`, `@covsel/adapter-jest` needs `jest`, and
`@covsel/adapter-cucumber` needs `@cucumber/cucumber`.

Declaring them makes npm install what is missing and pnpm and yarn say what is,
so the requirement reaches someone who installs an adapter by hand rather than
through `covsel init`. The ranges are deliberately open: the adapters are
written against each runner's stable coverage output rather than a version
floor anyone has tested, and a floor asserted without testing would be a guess.
