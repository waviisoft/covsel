---
'@covsel/core': minor
'covsel': patch
---

Treat an executed-but-unmappable script as a recording failure, and resolve
source maps from a sidecar, an inline `data:` URI, over HTTP, or a build
directory.

A map entry that records no sources is indistinguishable from a test that
genuinely covers nothing, and selection reads it the second way. That is
reachable from a stock bundler setup: `vite build` emits no source map unless
asked, and `sourcemap: 'hidden'` writes the map while stripping the comment that
points at it. Recording a suite whose tests reach their code through such a
build produced entries that existed and credited nothing, so editing the file
every test executes selected zero tests — not a full run, nothing. `recordMap`
already refuses to write a partial map because a partial map cannot be trusted;
the same rule now exists one level down, where a script becomes sources.

A script that executed and resolves to no source in the repository now fails the
recording with `UnmappableScriptError`, naming the script, and no map is
written. Scripts covsel can account for are unaffected: a file in the repository
is its own source, vendored code under `node_modules` is covered by the lockfile
sentinel rather than by coverage, and the runtime's own scripts are not the
project's code. What fails is code built from this repository and handed back to
the runner — out of a build directory, or over HTTP — with no way to trace it
home.

The discovery half ships with it. `SourceMapResolver` finds a script's map
through a `sourceMappingURL` comment naming a sidecar, the same comment carrying
the map inline as a `data:` URI, the conventional `<script>.map` neighbour when
a build stripped the comment, an HTTP fetch for scripts a browser loaded from a
dev server, and `sourceMaps.buildDirs`, which maps a serve-time URL prefix onto
the directory holding the built assets. A served path may not walk out of the
directory it was mapped onto. Only the `sources` list is read: until executed
ranges are projected through the mappings, a mapped script credits every source
it was built from, which over-selects rather than under-selects.

Scripts that will never be mappable — a third-party widget on the page under
test — can be accepted with `sourceMaps.allowUnmappable`, matched strictly so a
glob cannot quietly cover more than it says. Each entry is a hole in the
recording, so `covsel record` names the scripts it let through every time it
lets one through.
