/**
 * `harness` is core's one opaque, adapter-owned config field (see
 * `@covsel/core`'s `CovselConfig.harness`) — this module is what actually
 * understands its shape, validated once, at recorder-construction time, so a
 * misconfigured project hears about it before paying for a recording.
 */
import { parseRunTemplate, type RunTemplate } from './run-template.js';

export interface HarnessServerConfig {
  /** Where the application's inspector listens. Defaults to Node's own default. */
  inspectUrl: string;
  /**
   * Repo-relative globs the server window can see. Required, and not
   * defaulted: `**` would claim it watched everything a full run would, and
   * `[]` would make it useless — only the project knows what its server
   * actually executes.
   */
  observes: string[];
}

/** Presence, not its (by default empty) contents, selects the boundary-protocol recording path over one invocation per test. */
export interface HarnessBoundaryConfig {
  /**
   * How long a single inspector round trip (opening or closing a coverage
   * window) may take before that window fails. Passed straight through to
   * `RemoteCoverageSession`; defaults to its own default.
   */
  timeoutMs?: number;
  /**
   * How long one test's window may stay open -- from `/begin`'s response to
   * a matching `/end` -- before covsel gives up on it and fails the whole
   * recording, killing the harness rather than waiting on it forever. This is
   * a safety net against a genuinely stuck harness or application, not a
   * budget for a slow test: it defaults generously (ten minutes) because a
   * default that is too short costs nothing but an annoying failure -- a
   * recording that never completes still falls open to a full run -- while
   * one with no ceiling at all can hang `covsel record` indefinitely with
   * nothing to explain why.
   */
  testTimeoutMs?: number;
}

/** Ten minutes: generous for a real test, and still short enough that a stuck
 * harness fails the recording within a CI job's own timeout rather than
 * exhausting it silently. */
export const DEFAULT_TEST_TIMEOUT_MS = 600_000;

export interface HarnessConfig {
  run: RunTemplate;
  server: HarnessServerConfig;
  boundary?: HarnessBoundaryConfig;
}

const DEFAULT_INSPECT_URL = 'http://127.0.0.1:9229';

function fail(message: string): never {
  throw new Error(`covsel: harness config ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate `config.harness`, whatever the project wrote — core does
 * not check its shape, so a JSON typo or a missing `server.observes` has to be
 * caught here, before a whole suite is recorded against it.
 */
export function resolveHarnessConfig(raw: unknown): HarnessConfig {
  if (!isRecord(raw)) {
    fail(
      'is missing or not an object. Set `harness.run` and `harness.server` -- ' +
        'see the adapter-harness docs for the shape.',
    );
  }

  const runValue = raw.run;
  if (typeof runValue !== 'string') {
    fail(
      '.run is missing or not a string. It is the argument fragment your ' +
        'harness understands as "run only these tests", e.g. "--only {id}".',
    );
  }
  const run = parseRunTemplate(runValue);

  const serverValue = raw.server;
  if (!isRecord(serverValue)) {
    fail(
      '.server is missing or not an object. covsel records this adapter from ' +
        "the application server's inspector, so it needs to know where that " +
        'inspector listens and what code it may claim to have observed: ' +
        '`harness.server = { "observes": ["src/**"] }`.',
    );
  }
  const observesValue = serverValue.observes;
  if (
    !Array.isArray(observesValue) ||
    !observesValue.every((g) => typeof g === 'string') ||
    observesValue.length === 0
  ) {
    fail(
      '.server.observes is missing, empty, or not a list of globs. Nothing ' +
        'default here is honest: `**` would claim the server window watched ' +
        'everything a full run would, and covsel cannot infer what your server ' +
        'actually executes. Declare the globs whose code the server runs, e.g. ' +
        '`"observes": ["src/**"]`. Everything outside it falls open to a full ' +
        'run on change, which is the safe reading of code this recording did ' +
        'not claim to see.',
    );
  }
  const inspectUrlValue = serverValue.inspectUrl;
  if (inspectUrlValue !== undefined && typeof inspectUrlValue !== 'string') {
    fail('.server.inspectUrl is not a string.');
  }

  let boundary: HarnessBoundaryConfig | undefined;
  const boundaryValue = raw.boundary;
  if (boundaryValue !== undefined) {
    if (!isRecord(boundaryValue)) fail('.boundary is not an object.');
    const timeoutMsValue = boundaryValue.timeoutMs;
    if (timeoutMsValue !== undefined && typeof timeoutMsValue !== 'number') {
      fail('.boundary.timeoutMs is not a number.');
    }
    const testTimeoutMsValue = boundaryValue.testTimeoutMs;
    if (testTimeoutMsValue !== undefined && typeof testTimeoutMsValue !== 'number') {
      fail('.boundary.testTimeoutMs is not a number.');
    }
    boundary = {
      ...(timeoutMsValue !== undefined ? { timeoutMs: timeoutMsValue } : {}),
      ...(testTimeoutMsValue !== undefined ? { testTimeoutMs: testTimeoutMsValue } : {}),
    };
  }

  return {
    run,
    server: {
      inspectUrl: inspectUrlValue ?? DEFAULT_INSPECT_URL,
      observes: [...observesValue],
    },
    ...(boundary !== undefined ? { boundary } : {}),
  };
}
