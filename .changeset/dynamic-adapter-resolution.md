---
'covsel': major
'@covsel/core': minor
'@covsel/adapter-cucumber': minor
'@covsel/adapter-generic': minor
'@covsel/adapter-jest': minor
'@covsel/adapter-node-test': minor
'@covsel/adapter-vitest': minor
---

Resolve every adapter from the project that installed it. `covsel` now ships
none of them.

**Breaking, hence the major bump on `covsel`: installing the CLI is no longer
enough.** Install the adapter for your runner alongside it —
`npm install --save-dev covsel @covsel/adapter-vitest` — including
`@covsel/adapter-generic` for the zero-integration wrap that `--adapter`
defaults to. Until now the CLI depended on all five adapter packages and
imported them statically, so every install carried four runners' worth of code
it would never load, and a runner covsel had not adopted could not be selected
at all without a pull request adding it to a map in the CLI.

`--adapter mocha` now looks for `@covsel/adapter-mocha`, then
`covsel-adapter-mocha`; a name that is already a specifier
(`--adapter @acme/our-adapter`) is imported as written. `record`, `affected`,
and `run` all resolve the same way, and nothing is privileged — the adapters
covsel publishes load through exactly the same path as one you publish, so a
project can pin, fork, or replace any of them.

Resolution is anchored to your project rather than to covsel's own location on
disk, so the copy that loads is the one your project installed even when covsel
is installed globally or you are inside a monorepo. An adapter that is not
installed is reported with the command to install it; an adapter whose own
dependency fails to import is reported as a load failure rather than as absent,
because the two need different fixes.

`@covsel/core` gains `assertAdapter(value, source)`, which narrows an arbitrary
value to `Adapter` or throws naming the capability that is missing or mistyped.
Core owns the interface, so it owns the runtime check for it. The strictness is
a fail-open concern rather than tidiness: an adapter accepted but unable to
drive its runner yields a recorder that produces nothing, and a map recording
that a test covers nothing skips that test on every diff afterwards — so a
module that does not satisfy the contract is refused before recording starts.

Each adapter package now also exports its adapter as `adapter`, which is the
export the resolver reads (a default export works too). The existing named
exports are unchanged.

Fixes the CommonJS builds of `@covsel/adapter-node-test` and
`@covsel/adapter-cucumber`, which threw `ERR_INVALID_URL` the moment they were
required: both resolve a preload shim relative to `import.meta.url`, which is
empty in a CommonJS bundle. Their builds now emit the compatibility shim for it.
Only the ESM entry points were exercised before, which is why this went
unnoticed.
