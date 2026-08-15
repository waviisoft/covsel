---
'@covsel/adapter-cucumber': minor
'@covsel/adapter-playwright': minor
'@covsel/adapter-mocha': minor
'@covsel/adapter-jest': minor
'@covsel/core': minor
---

Answer `covsel doctor` from Jest, Mocha, Cucumber and Playwright, not only Vitest.

`covsel doctor` compares covsel's idea of the suite against the runner's own, and
an adapter that cannot ask its runner leaves that check unmade — reported as
`unavailable`, which is honest but is not a guard. Four more adapters can now
answer, so four more projects get one:

| Runner     | Asked with                  |
| ---------- | --------------------------- |
| Jest       | `--listTests --json`        |
| Mocha      | `--dry-run --reporter json` |
| Cucumber   | `--dry-run --format json`   |
| Playwright | `--list --reporter=json`    |

`node --test` still has no listing mode and the generic wrap still cannot know
what it is wrapping, so both continue to omit the capability rather than guess.

The handling every listing shares now lives in `@covsel/core` — the spawn and its
timeout, the strict "this was not a listing" checks, the refusal to answer a
command that narrows the run, and the normalisation to repo-relative POSIX paths.
That handling is load-bearing rather than incidental: a listing that half-works is
worse than one that fails, because a partial set compares against covsel's full
discovery as drift and sends someone editing `testGlobs` over a question the
runner was never asked. Getting it identically right in five hand-written places
is how the five stop agreeing.

Each runner keeps what is genuinely its own. Mocha and Cucumber have no list mode
at all, so they answer from a dry run, which loads the files without executing
the tests; Mocha's enumerates _tests_, so a spec file holding none is invisible to
it — able to miss a file rather than invent one, which is the right way round.
Playwright reports paths relative to its own `rootDir` and nests its suites one
layer per project, so its specs are walked rather than read off the top level.

`listTests` is now also checked by `assertAdapter`, alongside `runSelection`, so
a third-party adapter shipping something that is not callable is rejected by name
up front instead of failing at the call.
