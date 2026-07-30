---
'@covsel/adapter-node-test': patch
'@covsel/adapter-cucumber': patch
'@covsel/core': minor
---

Carry the mapper's configuration into the per-test recorders.

The node:test and cucumber adapters map coverage inside the runner they spawn, and each was handing that runner three configuration fields it had picked by hand. `sourceMaps` was not among them, so `allowUnmappable`, `buildDirs`, and `http` were inert for both: a project whose tests reach their code through a build with no source map could accept that gap in its config, watch the generic wrap honor it, and still find recording impossible under either per-test adapter. The failure direction was safe — recording refuses rather than crediting nothing — but it was total, and nothing said why, because the setting had simply never arrived.

Both recorders now carry exactly what the mapper reads, and both report the scripts it let through, so `covsel record` names accepted gaps whichever adapter produced the map. `@covsel/core` exports the `MapperConfig` type and `toMapperConfig` to make that one narrowing rather than one per adapter, and `toMapperConfig` names every key under a type that requires all of them — including optional ones, which is how `sourceMaps` was dropped in the first place. Adding a field to what the mapper reads now stops the carriers compiling.

Recording also drops what a failed file let through unmapped before moving to the next one. A recorder that accumulates across files would otherwise carry it forward, and the next file's progress line would name a script that file never executed.
