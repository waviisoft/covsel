"""Reference client for covsel's boundary protocol.

See docs/guide/adapters/boundary-protocol.md for the spec this implements: a
harness posts "begin" and "end" around each test to the URL covsel gives it in
`COVSEL_BOUNDARY`, and waits for the response before continuing, so covsel can
open and close its coverage window exactly at the boundary.

With `COVSEL_BOUNDARY` unset -- every invocation except the one recording
through the boundary protocol -- every call here is a no-op, which is what
lets a harness carry this permanently rather than switching it on and off.

Deliberately small and dependency-free (standard library only), so it reads as
a spec any language can follow, not as a library to depend on.
"""

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
        # A non-2xx means covsel has already failed the recording -- most often
        # two tests overlapping -- and continuing would only spend CI minutes
        # on a run nothing will use.
        raise RuntimeError(f"covsel boundary refused {path}: HTTP {error.code}") from error


@contextlib.contextmanager
def test(test_id):
    """Announce one test's boundary. Use as `with covsel_boundary.test(id): ...`."""
    _post("/begin", {"id": test_id})
    outcome = "passed"
    try:
        yield
    except Exception:
        outcome = "failed"
        raise
    finally:
        _post("/end", {"id": test_id, "outcome": outcome})
