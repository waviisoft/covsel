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
units execute, plus a `breakingEdit` that makes both of them fail. It is required
of a fixture used with an adapter whose declared scope does not cover the whole
fixture — one in which every unit executes only code the recorder can see never
exercises a narrow declaration, and the suite refuses that combination rather
than passing it. Nothing lies outside `OBSERVES_EVERYTHING`, so an adapter that
observes its whole runner needs no such fixture and behaves exactly as before;
supply one anyway and the recorder is held to having recorded it.

Two fixture properties are proved rather than trusted, the way the shared source
must be reached indirectly and a `bodyEdit` must reach a function body. The suite
applies the breaking edit and runs both units: if they still pass, the blind spot
is code nothing reaches, and the fixture is rejected instead of certifying a
fall-open nothing exercised. A `blindSpot` naming a test file or a sentinel is
rejected outright, because a change to either forces a full run whatever the
recording observed and so could never show that the declared scope was what
caused one.
