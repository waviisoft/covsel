# The boundary protocol

A small, language-neutral protocol that lets a test harness covsel cannot
load code into announce test boundaries anyway, so one full-suite invocation
can also be [the recording](/guide/adapters/harness#the-boundary-protocol).
Nothing about this is specific to covsel's implementation: any runner, in any
language, can speak it, and this page is the spec — deliberately independent
of the [`@covsel/adapter-harness`](/guide/adapters/harness) page, which
describes covsel's side of it.

## Overview

covsel starts a small HTTP server before spawning the harness, and passes its
URL in the harness's environment as `COVSEL_BOUNDARY`. A cooperating harness
posts two requests around each test it runs and **waits for the response
before continuing**:

- `POST {COVSEL_BOUNDARY}/begin` — before the test runs.
- `POST {COVSEL_BOUNDARY}/end` — after it finishes.

If `COVSEL_BOUNDARY` is unset, a cooperating harness does nothing at all —
which is what makes it safe to build into a harness permanently, on by
default, rather than something to switch on only for a recording.

## Why the harness has to wait

covsel needs to open its coverage window on the application server exactly
when a test starts, and close it exactly when it ends. If the harness fired
both requests without waiting for a response, it could start running the
next test before covsel had finished handling the previous one's `end` —
crediting the wrong test with the wrong server execution, silently. Waiting
for the response is what makes the boundary a boundary.

## `POST /begin`

Request body:

```json
{ "id": "<test id>" }
```

`id` is the same id `covsel affected`/`covsel run` would select this test by
— for now, the repo-relative path covsel discovered it under.

A `200` response means covsel has opened a coverage window for this test;
the harness may now run it. Any other status means covsel has already
failed the recording — most often because another test's window was still
open — and a well-behaved harness should stop rather than continue spending
CI minutes on a run nothing will use.

## `POST /end`

Request body:

```json
{ "id": "<test id>", "outcome": "passed" | "failed" | "skipped" }
```

`id` must match the test named in the most recent `/begin` — the protocol
runs one test at a time, with no interleaving. `outcome` says what covsel
cannot otherwise know from the HTTP exchange:

- **`passed`** — the coverage collected is recorded normally.
- **`failed`** — the coverage collected is discarded. A test that failed may
  have stopped before running the part of itself its coverage is really
  about, so it is treated the same as a test the run never mentioned at all:
  it stays selected on the next run rather than being recorded as covering
  whatever it happened to reach before failing.
- **`skipped`** — recorded as covering nothing, which keeps it selected on
  every run until it is actually exercised, rather than being read as
  "unaffected by anything."

A `200` response means covsel has closed the window and is ready for the
next `/begin`.

## Ordering

Strict, and unbuffered: `begin(A)`, `end(A)`, `begin(B)`, `end(B)`, ... A
`/begin` while another test's window is still open, or an `/end` naming a
test that is not the one currently open, is a protocol violation. It fails
the whole recording, not just the one test that violated it: an overlap
means the coverage window that just closed cannot be attributed to either
test with confidence.

## Reference client

A minimal client needs three things: read `COVSEL_BOUNDARY` once, and wrap
each test in a `begin`/`end` pair that reports `failed` on an exception. In
Python, using only the standard library:

```python
import contextlib
import json
import os
import urllib.error
import urllib.request

_BOUNDARY = os.environ.get("COVSEL_BOUNDARY")


def _post(path, body):
    if not _BOUNDARY:
        return
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"{_BOUNDARY}{path}",
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=30).read()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"covsel boundary refused {path}: HTTP {error.code}") from error


@contextlib.contextmanager
def test(test_id):
    _post("/begin", {"id": test_id})
    outcome = "passed"
    try:
        yield
    except Exception:
        outcome = "failed"
        raise
    finally:
        _post("/end", {"id": test_id, "outcome": outcome})
```

Used as:

```python
with covsel_boundary.test("harness/tests/checkout.harness"):
    run_the_test()
```

The full, runnable version of this client — `covsel_boundary.py` — lives in
[`examples/harness-basic`](https://github.com/waviisoft/covsel/tree/main/examples/harness-basic),
alongside a tiny Node server and a Python harness that drives it through both
recording modes.
