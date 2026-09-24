import { spawnSync } from 'node:child_process';

import type { CovselConfig } from './config.js';
import type { CoverageMap, InventoryEntry, TestId, TestInventory } from './schema.js';

/**
 * Reading and diffing a test inventory: an adapter's or another tool's answer
 * to "which tests exist, and did their definitions change", supplied instead
 * of covsel discovering tests as files in this repository's own diff.
 *
 * Every ambiguity here fails toward the full run covsel does today for a
 * project with no inventory at all, or toward running the one test the map
 * cannot vouch for -- never toward an empty selection.
 */

/** What running `inventory.command` produced, or why it could not be trusted. */
export type TestInventoryResult =
  | { readonly ok: true; readonly inventory: TestInventory }
  | { readonly ok: false; readonly reason: string };

/** A stable key for a test id, matching the one every other selection path uses. */
function testKey(id: TestId): string {
  return `${id.file}\0${id.name ?? ''}`;
}

/**
 * Parse covsel's own inventory JSON shape from a command's output, or say why
 * it does not hold one.
 *
 * Validated field by field rather than trusted as `TestInventory`, because
 * this is the one place an external process's stdout enters the map: a
 * command that changed its output, or a `jq` filter with a typo, must be
 * caught here rather than crediting a test with a version nobody wrote.
 */
export function parseTestInventory(text: string): TestInventoryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      reason: `did not print valid JSON (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'the output is not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const source = obj['source'];
  if (typeof source !== 'string' || source === '') {
    return { ok: false, reason: 'it has no non-empty "source"' };
  }
  const rawEntries = obj['entries'];
  if (!Array.isArray(rawEntries)) {
    return { ok: false, reason: 'it has no "entries" list' };
  }

  const entries: InventoryEntry[] = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const raw = rawEntries[i];
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, reason: `entries[${i}] is not an object` };
    }
    const entry = raw as Record<string, unknown>;
    const id = entry['id'];
    if (typeof id !== 'object' || id === null) {
      return { ok: false, reason: `entries[${i}].id is not an object` };
    }
    const idObj = id as Record<string, unknown>;
    const file = idObj['file'];
    if (typeof file !== 'string' || file === '') {
      return { ok: false, reason: `entries[${i}].id.file is not a non-empty string` };
    }
    const name = idObj['name'];
    if (name !== undefined && typeof name !== 'string') {
      return { ok: false, reason: `entries[${i}].id.name is not a string` };
    }
    const version = entry['version'];
    if (version !== undefined && typeof version !== 'string') {
      return { ok: false, reason: `entries[${i}].version is not a string` };
    }
    entries.push({
      id: { file, ...(name !== undefined ? { name } : {}) },
      ...(version !== undefined ? { version } : {}),
    });
  }

  return { ok: true, inventory: { source, entries } };
}

/**
 * How long to wait for the inventory command before giving up.
 *
 * This runs on every `record`, `affected`, `status`, and `explain` -- not just
 * a diagnostic a user asks for on their own schedule -- so a command that never
 * exits must not be allowed to hang covsel, and by extension CI, indefinitely.
 * Generous rather than tight: unlike `listingOutput`'s listing flag, an
 * inventory command can legitimately do real work (checking out a pinned
 * intent repo, say), so this bounds a hang, not a slow answer.
 */
export const INVENTORY_TIMEOUT_MS = 120_000;

/**
 * Run `command` through a shell and parse its stdout as covsel's own
 * inventory JSON.
 *
 * A shell, not an argv, because the shape sketched for this config field is a
 * pipeline -- `vellum suite extract ... | jq '...'` -- and every alternative to
 * a shell forces the project to wrap that in a script file of its own just to
 * give covsel something to spawn directly.
 */
export function readTestInventory(init: {
  cwd: string;
  command: string;
}): TestInventoryResult {
  const res = spawnSync(init.command, {
    cwd: init.cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: INVENTORY_TIMEOUT_MS,
  });
  if (res.error) {
    const timedOut = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return {
      ok: false,
      reason: timedOut
        ? `did not finish within ${INVENTORY_TIMEOUT_MS / 1000}s`
        : `could not run: ${res.error.message}`,
    };
  }
  if (res.status !== 0) {
    const stderr = tail(res.stderr ?? '');
    return {
      ok: false,
      reason:
        `exited with status ${res.status ?? 'unknown'}` + (stderr ? `: ${stderr}` : ''),
    };
  }
  return parseTestInventory(res.stdout ?? '');
}

/** How much of a failed command's own output a full-run reason may quote. */
const STDERR_TAIL_LINES = 4;
const STDERR_TAIL_CHARS = 500;

/**
 * The last few lines of a command's stderr, capped in length -- never the
 * whole thing.
 *
 * This text lands in a full-run reason, which is printed to CI logs and
 * `covsel status`/`explain` output alike. A command that shells out to an
 * authenticated checkout can echo a token or a credential on failure, and
 * quoting it in full turns a fail-open message into a leak. A few lines is
 * enough to recognise the failure; it is not enough to be the failure.
 */
/**
 * A userinfo credential embedded in a URL -- `https://x-access-token:ghp_…@github.com/…` --
 * the shape a failed authenticated checkout's own error message actually
 * prints. Redacted before the line-and-length cap below, not after: the
 * credential usually sits on the very last line (the command's final
 * fatal error), which is exactly the line the cap keeps rather than drops.
 */
const URL_CREDENTIAL = /:\/\/[^/@\s]+@/g;

function tail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed === '') return '';
  const redacted = trimmed.replace(URL_CREDENTIAL, '://***@');
  const lines = redacted.split('\n').slice(-STDERR_TAIL_LINES).join('\n');
  return lines.length > STDERR_TAIL_CHARS ? `…${lines.slice(-STDERR_TAIL_CHARS)}` : lines;
}

/**
 * What comparing the map's recorded inventory against a freshly read one
 * means for the next selection.
 */
export type TestInventoryChange =
  | {
      /**
       * Ids the current inventory names that must run regardless of the diff:
       * new since the recording, whose version has changed, or that carry no
       * version at all.
       */
      readonly mandatory: readonly TestId[];
      /**
       * Every id the current inventory names, whether or not it is mandatory --
       * the set selection may draw a unit from even though it is not one
       * `discoverTestFiles` walked into.
       */
      readonly known: readonly TestId[];
      /** The current inventory's `source`, for a report to name. */
      readonly source: string;
      readonly fallOpen?: undefined;
    }
  | {
      readonly mandatory?: undefined;
      /**
       * Present only when a current inventory was actually read before this
       * fell open -- the `source` mismatch case, where the ids this run just
       * read are the honest answer to "what should a full run's own output
       * name", not the (now superseded) ones the map recorded.
       */
      readonly known?: readonly TestId[];
      readonly source?: undefined;
      /** Why the next selection has to be a full run. */
      readonly fallOpen: string;
    };

/**
 * Compare what the map recorded against a freshly read inventory, or say why
 * the comparison forces a full run.
 *
 * `undefined` means there is nothing to compare: the project configures no
 * inventory and the map recorded none either, or the map measured nothing at
 * all -- the same "not a downgrade that failed" reading {@link dependencyChange}
 * gives an entry-less map, since there is no selection here to narrow either
 * way.
 */
export function testInventoryChange(init: {
  cwd: string;
  config: Pick<CovselConfig, 'inventory'>;
  map: CoverageMap;
  /**
   * A `readTestInventory` result already taken this run, so a caller that
   * had to read it early -- before it even knew whether it had a usable map
   * to compare against, because a full run's own output has to name what
   * currently exists regardless -- does not ask the command a second time.
   * Read fresh when omitted.
   */
  current?: TestInventoryResult;
}): TestInventoryChange | undefined {
  const { cwd, config, map } = init;
  if (map.entries.length === 0) return undefined;

  if (config.inventory === undefined) {
    // The map claims a baseline to compare tests against, but this run has no
    // way to ask the question at all -- a config drifting out of step between
    // the job that recorded the map and this one (a missing env var, a
    // reverted field). Read the same way `dependencyChange` reads a lockfile
    // it cannot establish the installed tree for: the claim stands and this
    // run cannot verify it, so it falls open rather than silently answering
    // "nothing changed" for an axis it never checked.
    if (map.testInventory !== undefined) {
      return {
        fallOpen:
          'the map was recorded against a test inventory, but this run configures none',
      };
    }
    return undefined;
  }

  const result =
    init.current ?? readTestInventory({ cwd, command: config.inventory.command });
  if (!result.ok) {
    return {
      fallOpen: `the test inventory could not be produced: ${result.reason}`,
    };
  }
  const current = result.inventory;
  const known = current.entries.map((e) => e.id);
  const recorded = map.testInventory;

  // A different harness can change what every test in it does without moving
  // a single id or version, so this is read the way a sentinel is: whatever
  // else the diff says, the whole suite runs. `known` still names this run's
  // own ids -- the ones a full run's own output should list -- since the
  // recorded inventory is what just got invalidated.
  if (recorded !== undefined && current.source !== recorded.source) {
    return {
      fallOpen: `the harness changed (${recorded.source} -> ${current.source})`,
      known,
    };
  }

  const recordedVersions = new Map<string, string | undefined>();
  for (const entry of recorded?.entries ?? []) {
    recordedVersions.set(testKey(entry.id), entry.version);
  }

  const mandatory: TestId[] = [];
  for (const entry of current.entries) {
    const key = testKey(entry.id);
    // Never assume unchanged: an id the recording never saw, one whose
    // version moved, and one that carries no version at all are all read the
    // same way an unrecorded test file is.
    if (
      entry.version === undefined ||
      !recordedVersions.has(key) ||
      recordedVersions.get(key) !== entry.version
    ) {
      mandatory.push(entry.id);
    }
  }

  return { mandatory, known, source: current.source };
}
