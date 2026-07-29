---
'@covsel/conformance': minor
---

Hold an adapter to the observability scope it declares.

The existing checks certify what an adapter records. None of them certify what it
could not have recorded. Every fixture the kit builds executes inside the process
tree the recorder controls, so a recorder that sees all of a test's execution and
one that sees a fraction of it produce identical reports. A recorder that
collects coverage from a browser and nothing of the server the page talks to is
precise, deterministic, internally consistent, and blind to a whole region of the
codebase — and every check passes, because under-recording is if anything _more_
precise.

The new check reads the recorded map back against the scope it was recorded with,
in both directions. Nothing an adapter records may lie outside that scope:
coverage there is never read, so reporting it means the declaration describes
something other than what the recorder watches. And anything inside that scope
the fixture's units execute must appear in the map, because a recorder claiming
ground it was never watching is what turns a blind spot into "this code ran
nowhere".

Exercising the second half needs a fixture that executes code across the
boundary, so `ConformanceFixture` grows an optional `blindSpot`: a source both
units execute, plus a `breakingEdit` that makes both of them fail. A recorder
declaring less than the whole repo must have one outside its scope, since a
fixture whose units execute nothing out there never exercises the declaration.
That question is asked of the declaration rather than of the fixture's file list,
so an asset no unit executes neither demands a blind spot nor stands in for one.
Nothing lies outside `OBSERVES_EVERYTHING`, so an adapter that observes its whole
runner needs none — and every adapter shipped here supplies one anyway, which is
what holds each recorder to having recorded code it claims it could see.

Two fixture properties are proved rather than trusted, the way the shared source
must be reached indirectly and a `bodyEdit` must reach a function body. The blind
spot is proved load-bearing by difference: both units are run whole and required
to pass, the breaking edit is applied, and the run is required to fail — a
non-zero exit alone would also be produced by a runner that runs nothing and
reports failure. And a `blindSpot` naming a test file or a sentinel is rejected
outright, because a change to either forces a full run whatever the recording
observed and so could never show that the declared scope was what caused one.

An adapter that declares a partial scope and reports coverage outside it — safe,
but inconsistent — newly fails conformance. Report only what the declaration
covers; widen the declaration only for paths the recorder really would have seen.
