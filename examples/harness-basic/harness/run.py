#!/usr/bin/env python3
"""A toy external harness: drives the Node app in server.mjs over HTTP.

Mirrors what a real acceptance harness (pytest + requests, a Playwright-for-
Python suite) looks like from covsel's side: a runner in a language covsel
does not run itself, invoked either once per selected test id (`--only`,
repeatable) or once for the whole suite, in which case it cooperates with
covsel's boundary protocol through covsel_boundary.py when COVSEL_BOUNDARY is
set.
"""

import argparse
import os
import sys
import urllib.request

import covsel_boundary

APP_URL = os.environ.get("HARNESS_APP_URL", "http://127.0.0.1:8934")

TESTS = {
    "harness/tests/add.harness": {"path": "/add", "expect": 7},
    "harness/tests/sub.harness": {"path": "/sub", "expect": 1},
    # Not a file in this repository at all -- named only by inventory.mjs's
    # own output, to prove a scenario needs no anchor file under `testGlobs`.
    "spec:mul": {"path": "/mul", "expect": 12},
}


def run_one(test_id):
    test = TESTS[test_id]
    with urllib.request.urlopen(f"{APP_URL}{test['path']}", timeout=10) as response:
        value = int(response.read().decode().strip())
    if value != test["expect"]:
        raise AssertionError(f"{test_id}: expected {test['expect']}, got {value}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", action="append", default=[])
    parser.add_argument("--format", default="text")
    args = parser.parse_args()

    ids = args.only or list(TESTS.keys())
    failed = False
    for test_id in ids:
        try:
            with covsel_boundary.test(test_id):
                run_one(test_id)
            print(f"PASS {test_id}")
        except Exception as exc:  # noqa: BLE001 -- reported, then the suite continues
            failed = True
            print(f"FAIL {test_id}: {exc}", file=sys.stderr)

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
