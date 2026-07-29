/**
 * The runtime side of the adapter contract. The interface itself is compile-time
 * only, which is enough while every adapter is built against it -- but a consumer
 * that loads an adapter it did not compile against, from a package it does not
 * control, has to be able to ask whether what it got is really an adapter.
 */

import type { Adapter } from './interfaces.js';

/** What a value must have to drive a runner, and what to call each part. */
const REQUIRED = [
  ['name', 'string'],
  ['formatSelection', 'function'],
  ['createRecorder', 'function'],
] as const;

/** The capabilities an adapter may omit, and the type they take when present. */
const OPTIONAL = [['runSelection', 'function']] as const;

/**
 * Narrow an arbitrary value to an `Adapter`, or throw explaining what is wrong
 * with it.
 *
 * The strictness is deliberate, and it is a fail-open concern rather than a
 * tidiness one. An adapter that is accepted but cannot really drive its runner
 * produces a recorder that yields nothing, and a map recording that a test
 * covers nothing is a map that skips that test on every diff afterwards. The
 * only cheap place to catch that is before recording starts, so anything that
 * does not satisfy the contract is rejected here, by name.
 */
export function assertAdapter(value: unknown, source: string): asserts value is Adapter {
  // Annotated on the binding, not just the arrow, so the compiler knows a call
  // to it ends the flow and the checks below read as the early exits they are.
  const fail: (problem: string) => never = (problem) => {
    throw new Error(`${source} is not a covsel adapter: ${problem}`);
  };
  if (typeof value !== 'object' || value === null) {
    fail(`expected an object, got ${value === null ? 'null' : typeof value}`);
  }
  const candidate = value as Record<string, unknown>;
  for (const [key, type] of REQUIRED) {
    if (!(key in candidate)) fail(`no ${key}`);
    if (typeof candidate[key] !== type) {
      fail(`${key} is ${typeof candidate[key]}, expected ${type}`);
    }
  }
  if (candidate['name'] === '') fail('name is empty');
  for (const [key, type] of OPTIONAL) {
    if (candidate[key] !== undefined && typeof candidate[key] !== type) {
      fail(`${key} is ${typeof candidate[key]}, expected ${type} or nothing`);
    }
  }
  const globs: unknown = candidate['defaultTestGlobs'];
  if (globs !== undefined) {
    if (!Array.isArray(globs) || globs.some((g) => typeof g !== 'string')) {
      fail('defaultTestGlobs is not an array of strings');
    }
    if (globs.length === 0) {
      // An empty list would discover no tests at all, which reads as "this
      // project has no tests" and selects nothing -- the one outcome covsel
      // must never produce quietly.
      fail('defaultTestGlobs is empty, so no test would ever be discovered');
    }
  }
}
