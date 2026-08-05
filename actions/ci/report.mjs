/**
 * Turn covsel's machine-readable answers into a job summary and step outputs.
 *
 * The summary is the point as much as the outputs are. Over-selection is
 * invisible by construction -- a job that selects everything passes exactly like
 * one that selects three files -- so the only way anyone finds out their cache
 * key is wrong, or their checkout too shallow, is a line saying "37 of 37, full
 * run, because the map records no commit this checkout has".
 *
 * Plain JavaScript with no dependencies, because GitHub runs an action from the
 * checked-out ref with no install step. Everything here is a pure function over
 * the parsed JSON, with the file and environment handling at the bottom, so the
 * reporting can be tested without a runner.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * What the commands between them said. Several fields are optional because each
 * describes a command that may not have run: `record` mode makes no selection,
 * and a `select` run whose fetch found nothing still has a status to report.
 *
 * @typedef {object} Facts
 * @property {'select' | 'record'} mode
 * @property {boolean} dryRun
 * @property {boolean} fullRun
 * @property {string | undefined} fullRunReason
 * @property {number | undefined} selectedCount
 * @property {number | undefined} discoveredCount
 * @property {string[]} affected
 * @property {string} mapState
 * @property {string | undefined} mapCommit
 * @property {number | undefined} mapAgeMs
 * @property {string | undefined} mapReason
 * @property {{ commit: string, reason: string }[]} skipped
 * @property {string | undefined} fetchReason
 */

/**
 * Read the facts out of the parsed command output.
 *
 * A missing selection is not a selection of nothing: in `record` mode the
 * command never ran, and reporting "0 selected" there would describe a narrowing
 * that was never attempted. Absent stays absent all the way to the summary,
 * where it prints as unknown rather than as a number.
 *
 * @param {{ mode?: string, dryRun?: boolean, affected?: any, status?: any, fetch?: any }} input
 * @returns {Facts}
 */
export function readFacts(input) {
  const affected = input.affected;
  const status = input.status ?? {};
  const fetched = input.fetch;
  const selected = affected === undefined ? undefined : (affected.tests ?? []);
  return {
    mode: input.mode === 'record' ? 'record' : 'select',
    dryRun: input.dryRun === true,
    // A run covsel could not narrow is a full run whether that verdict came from
    // the selection or -- in record mode, where there is no selection -- from
    // what status says the next one would be.
    fullRun:
      affected === undefined ? status.nextIsFullRun === true : affected.fullRun === true,
    fullRunReason: affected === undefined ? status.nextFullRunReason : affected.reason,
    selectedCount: selected?.length,
    discoveredCount:
      affected === undefined ? status.discoveredTestCount : affected.discovered,
    affected: selected ?? [],
    mapState: status.mapState ?? 'absent',
    mapCommit: status.commit,
    mapAgeMs: status.ageMs,
    mapReason: status.unusableReason,
    skipped: fetched?.skipped ?? [],
    fetchReason: fetched?.ok === false ? fetched.reason : undefined,
  };
}

/** Milliseconds as something a person reads at a glance. */
function age(ms) {
  if (ms === undefined) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * The headline: what covsel did, in one sentence, with the count that makes it
 * mean anything. "4 selected" is not a fact anyone can act on; "4 of 37" is.
 *
 * @param {Facts} facts
 */
export function headline(facts) {
  const discovered = facts.discoveredCount;
  if (facts.mode === 'record') {
    return facts.mapState === 'usable'
      ? `Recorded and published a map covering ${discovered ?? 'an unknown number of'} test file(s).`
      : 'Recording finished, but the store holds no usable map.';
  }
  if (facts.fullRun) {
    const scope =
      discovered === undefined
        ? 'Every test file runs'
        : `All ${discovered} test file(s) run`;
    return `Full run: ${scope}${facts.fullRunReason === undefined ? '' : ` -- ${facts.fullRunReason}`}.`;
  }
  const of = discovered === undefined ? '' : ` of ${discovered}`;
  // "unknown", not 0. A count nobody measured is not a selection of nothing, and
  // rendering it as one describes a narrowing that never happened.
  const count = facts.selectedCount ?? 'an unknown number of';
  return `Selected ${count}${of} test file(s); only those ${
    facts.dryRun ? 'would run' : 'ran'
  }.`;
}

/**
 * The job summary, as GitHub-flavoured Markdown.
 *
 * @param {Facts} facts
 */
export function summary(facts) {
  const lines = ['### covsel', '', headline(facts), ''];
  if (facts.dryRun) {
    lines.push(
      '> Dry run -- covsel selected but ran nothing, so whatever already gates this pull request still does.',
      '',
    );
  }
  lines.push('| | |', '| --- | --- |');
  lines.push(
    `| Map | ${facts.mapState}${facts.mapReason === undefined ? '' : ` (${facts.mapReason})`} |`,
  );
  if (facts.mapCommit !== undefined) {
    lines.push(
      `| Recorded at | \`${facts.mapCommit.slice(0, 12)}\`, ${age(facts.mapAgeMs)} ago |`,
    );
  }
  if (facts.mode === 'select') {
    // `unknown`, not 0, for the same reason `headline` says so: the two
    // renderings of one fact must not be able to disagree about whether a
    // narrowing was measured or merely absent.
    lines.push(
      `| Selected | ${facts.fullRun ? 'everything' : (facts.selectedCount ?? 'unknown')} |`,
    );
    lines.push(`| Discovered | ${facts.discoveredCount ?? 'unknown'} |`);
  }
  lines.push('');

  if (facts.fetchReason !== undefined) {
    // A fetch that found nothing does not by itself mean a full run: `covsel
    // fetch` leaves an existing map in the store alone, so selection may have
    // narrowed against one that was already there. Report the verdict that was
    // reached rather than the one a failed fetch usually implies.
    lines.push(
      facts.fullRun
        ? `No archived map was installed: ${facts.fetchReason}. The suite runs in full, which is the safe outcome.`
        : `No archived map was installed: ${facts.fetchReason}. Selection used the map already in the store.`,
      '',
    );
  }
  // Every skipped candidate is a map someone published expecting it to be used.
  // Naming them is what turns "covsel saves us nothing" into "our checkout is
  // too shallow to contain the commit the map records".
  if (facts.skipped.length > 0) {
    lines.push('<details><summary>Archived maps passed over</summary>', '');
    for (const s of facts.skipped) {
      lines.push(`- \`${s.commit.slice(0, 12)}\` -- ${s.reason}`);
    }
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}

/**
 * Step outputs, as `key=value` lines.
 *
 * Values are flattened to one line: none of these is legitimately multi-line,
 * and a newline inside a reason would otherwise end the output early and leave
 * the rest of the sentence being read as another output.
 *
 * @param {Facts} facts
 */
export function outputs(facts) {
  const number = (n) => (n === undefined ? '' : String(n));
  const pairs = [
    ['full-run', String(facts.fullRun)],
    ['full-run-reason', facts.fullRunReason ?? ''],
    ['selected-count', number(facts.selectedCount)],
    ['discovered-count', number(facts.discoveredCount)],
    ['affected', JSON.stringify(facts.affected)],
    ['map-state', facts.mapState],
    ['map-commit', facts.mapCommit ?? ''],
    ['map-age-ms', number(facts.mapAgeMs)],
  ];
  return pairs.map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, ' ')}`).join('\n');
}

/** Read a JSON file the action wrote, or `undefined` when that step did not run. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function main() {
  // The directory the action made for this invocation, and no fallback to
  // $RUNNER_TEMP: that is shared by every step in the job, which is exactly the
  // sharing the per-invocation directory exists to avoid.
  const dir = process.argv[2] ?? '.';
  const mode = process.env['COVSEL_MODE'];
  const affected = readJson(join(dir, 'covsel-affected.json'));

  // In select mode the selection is the thing being reported, so a file that is
  // missing or half-written is a failure rather than an absence to render around.
  // Reporting it as "selected 0" would be a green step claiming a narrowing that
  // was never measured.
  if (mode !== 'record' && affected === undefined) {
    process.stderr.write(
      `covsel-action: no readable selection at ${join(dir, 'covsel-affected.json')}, ` +
        'so there is nothing to report\n',
    );
    process.exitCode = 1;
    return;
  }

  const facts = readFacts({
    mode,
    dryRun: process.env['COVSEL_DRY_RUN'] === 'true',
    affected,
    status: readJson(join(dir, 'covsel-status.json')),
    fetch: readJson(join(dir, 'covsel-fetch.json')),
  });

  const outputFile = process.env['GITHUB_OUTPUT'];
  if (outputFile !== undefined) appendFileSync(outputFile, `${outputs(facts)}\n`);

  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile !== undefined && process.env['COVSEL_SUMMARY'] !== 'false') {
    appendFileSync(summaryFile, `${summary(facts)}\n`);
  }

  // The log line, for whoever is reading the run rather than the summary.
  process.stdout.write(`covsel-action: ${headline(facts)}\n`);
}

// Run only when invoked as a script; importing this module for its functions
// must not write anything.
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) main();
