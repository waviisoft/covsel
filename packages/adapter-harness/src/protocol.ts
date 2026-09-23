/**
 * The boundary protocol: how a harness in any language announces test
 * boundaries to covsel over HTTP, so one full-suite invocation can also be the
 * recording.
 *
 * A cooperating runner reads `COVSEL_BOUNDARY` from its environment. Unset, it
 * does nothing — the protocol costs nothing to build into a harness
 * permanently. Set, it is the base URL of a server covsel starts before
 * spawning the harness, and the runner sends two requests around each test:
 *
 * - `POST {COVSEL_BOUNDARY}/begin` with `{"id": "<test id>"}`, before the test
 *   runs.
 * - `POST {COVSEL_BOUNDARY}/end` with `{"id": "<test id>", "outcome": "passed"
 *   | "failed" | "skipped"}`, after it finishes.
 *
 * Both are blocking: the runner waits for the response before continuing.
 * covsel needs the wait to open its coverage window exactly at the boundary and
 * to close it before the next test can start — a runner that fired both
 * without waiting could run two tests inside one window, and their coverage
 * would be attributed to neither correctly. A non-2xx response means covsel has
 * already failed the recording (a protocol violation, most often two tests
 * overlapping); a well-behaved runner stops rather than continuing to spend CI
 * minutes on a run nothing will use.
 *
 * Ordering is strict and unbuffered: begin(A), end(A), begin(B), end(B), ...
 * with no interleaving. A begin while another test is still open, or an end
 * naming a test that is not the open one, is a protocol violation and fails the
 * whole recording — not just the one test — because it means the coverage
 * window just closed cannot be trusted to belong to either test.
 *
 * `outcome` says what covsel cannot otherwise know from an HTTP exchange: a
 * `failed` test's coverage cannot be trusted (it may have stopped partway), so
 * it is treated as never having reported at all, per the same fail-open rule
 * that already applies to a test the run never mentions. A `skipped` test is
 * recorded as covering nothing, which is the honest reading and, on its own,
 * always selects it again rather than failing the run.
 */

/** Environment variable a cooperating harness reads. Unset means "do nothing". */
export const BOUNDARY_ENV = 'COVSEL_BOUNDARY';

/** What a harness reports about how a test went. */
export const OUTCOMES = Object.freeze(['passed', 'failed', 'skipped'] as const);
export type Outcome = (typeof OUTCOMES)[number];

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

/** Body of a `POST /begin` request. */
export interface BeginMessage {
  id: string;
}

/** Body of a `POST /end` request. */
export interface EndMessage {
  id: string;
  outcome: Outcome;
}

export function isBeginMessage(value: unknown): value is BeginMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

export function isEndMessage(value: unknown): value is EndMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { id?: unknown; outcome?: unknown };
  return typeof v.id === 'string' && isOutcome(v.outcome);
}
