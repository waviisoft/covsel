---
'@covsel/core': minor
'@covsel/adapter-cucumber': minor
'@covsel/adapter-generic': minor
'@covsel/adapter-jest': minor
'@covsel/adapter-node-test': minor
'@covsel/adapter-vitest': minor
'covsel': minor
---

Resolve third-party adapters from `--adapter`, so a published adapter is usable
without a change to covsel.

An adapter name covsel does not ship is now a package your project installed.
`--adapter mocha` tries `@covsel/adapter-mocha`, then `covsel-adapter-mocha`; a
name that is already a specifier (`--adapter @acme/our-adapter`) is imported as
written. `record`, `affected`, and `run` all resolve the same way. Until now a
third-party adapter could pass the conformance suite and still be unselectable
without a PR to `covsel` — the community lane `DESIGN.md` describes was
theoretical.

Resolution is anchored to your project, not to covsel's own location on disk, so
the adapter that loads is the one your project installed even when covsel is
installed globally or you are inside a monorepo. The five adapters covsel ships
always win over a package of the same name and load with nothing else installed.

`@covsel/core` gains `assertAdapter(value, source)`, which narrows an arbitrary
value to `Adapter` or throws naming the capability that is missing or mistyped.
Core owns the interface, so it owns the runtime check for it, and anything
loading adapters dynamically gets the same one. The strictness is a fail-open
concern rather than tidiness: an adapter accepted but unable to drive its runner
yields a recorder that produces nothing, and a map recording that a test covers
nothing skips that test on every diff afterwards — so a module that does not
satisfy the contract is refused before recording starts.

Three failures read differently, because their fixes differ: nothing installed
under any name tried (which lists the adapters covsel ships and the specifiers it
looked for), a module that is not an adapter (which names the capability that
failed), and a module that threw while loading (which surfaces the underlying
error rather than reporting the adapter as absent).

Each adapter package now also exports its adapter as `adapter`, so
`--adapter @covsel/adapter-vitest` resolves through exactly the path a
third-party package does. The existing named exports are unchanged.

Fixes the CommonJS builds of `@covsel/adapter-node-test` and
`@covsel/adapter-cucumber`, which threw `ERR_INVALID_URL` the moment they were
required: both resolve a preload shim relative to `import.meta.url`, which is
empty in a CommonJS bundle, so `require()` of either package — or of `covsel`
itself, which loads them — failed before doing anything. Their builds now emit
the compatibility shim for it. Only the ESM entry points were exercised before,
which is why this went unnoticed.
