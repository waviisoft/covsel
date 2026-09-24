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
  /**
   * How long, in milliseconds, to wait after a test's window would otherwise
   * close before actually reading and closing it. Unset or `0` (the default)
   * changes nothing: the window closes exactly when the harness's `/end` (or,
   * in per-test mode, the harness process's own exit) says the test is done.
   *
   * A real server sometimes keeps working after it has already responded to
   * the client — a fire-and-forget `.then()`, a scheduled callback — and that
   * work is invisible to covsel unless something delays the close past it.
   * Setting this is a mitigation, not a guarantee: work that finishes within
   * `settleMs` of the window's ordinary close is attributed to the test that
   * was open; anything after that still runs unattributed to any test, and
   * there is no way to detect this from outside the harness. Set it only when
   * you know your server does this, and only as long as the slowest such
   * callback you know about.
   */
  settleMs?: number;
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
  /**
   * How long, in milliseconds, one harness invocation may run in **per-test**
   * recording mode (`harness.boundary` unset) before covsel kills it and fails
   * that test's recording, rather than blocking `covsel record` forever on a
   * hung process. Defaults to the same generous bound the boundary protocol's
   * own per-test watchdog uses, for the same reason: short enough to fail
   * within a CI job's own timeout, long enough that a real test never trips
   * it. Unused by the boundary protocol, which has its own
   * `boundary.testTimeoutMs`.
   */
  testTimeoutMs?: number;
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
  const settleMsValue = serverValue.settleMs;
  if (settleMsValue !== undefined && typeof settleMsValue !== 'number') {
    fail('.server.settleMs is not a number.');
  }

  const topLevelTestTimeoutMsValue = raw.testTimeoutMs;
  if (
    topLevelTestTimeoutMsValue !== undefined &&
    typeof topLevelTestTimeoutMsValue !== 'number'
  ) {
    fail('.testTimeoutMs is not a number.');
  }

  let boundary: HarnessBoundaryConfig | undefined;
  const boundaryValue = raw.boundary;
  if (boundaryValue !== undefined) {
    if (!isRecord(boundaryValue)) fail('.boundary is not an object.');
    const timeoutMsValue = boundaryValue.timeoutMs;
    if (timeoutMsValue !== undefined && typeof timeoutMsValue !== 'number') {
      fail('.boundary.timeoutMs is not a number.');
    }
    const boundaryTestTimeoutMsValue = boundaryValue.testTimeoutMs;
    if (
      boundaryTestTimeoutMsValue !== undefined &&
      typeof boundaryTestTimeoutMsValue !== 'number'
    ) {
      fail('.boundary.testTimeoutMs is not a number.');
    }
    boundary = {
      ...(timeoutMsValue !== undefined ? { timeoutMs: timeoutMsValue } : {}),
      ...(boundaryTestTimeoutMsValue !== undefined
        ? { testTimeoutMs: boundaryTestTimeoutMsValue }
        : {}),
    };
  }

  return {
    run,
    server: {
      inspectUrl: inspectUrlValue ?? DEFAULT_INSPECT_URL,
      observes: [...observesValue],
      ...(settleMsValue !== undefined ? { settleMs: settleMsValue } : {}),
    },
    ...(boundary !== undefined ? { boundary } : {}),
    ...(topLevelTestTimeoutMsValue !== undefined
      ? { testTimeoutMs: topLevelTestTimeoutMsValue }
      : {}),
  };
}
