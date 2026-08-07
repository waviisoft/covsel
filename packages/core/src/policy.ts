import {
  changedConfigFields,
  CONFIG_FILES,
  type CovselConfig,
  recordedConfig,
} from './config.js';
import type { Change, Policy } from './interfaces.js';
import { makeMatcher, makeStrictMatcher } from './match.js';
import { type CoverageMap, isUsableMap, type TestId } from './schema.js';

const CONFIG_FILE_NAMES: ReadonlySet<string> = new Set<string>(CONFIG_FILES);

/**
 * What a diff was measured from, so a reason can say so.
 *
 * Every reason naming a changed file is about two states, and naming only one of
 * them leaves the reader to supply the other. The obvious guess -- "changed in my
 * branch" -- is wrong exactly when the message matters most: the window is the
 * commit the map records against the working tree, which on a pull request
 * includes everything merged to the default branch since the recording. A branch
 * that never touched `covsel.config.js` is told `covsel.config.js changed`, and
 * the author's first move is to search a diff that does not contain it.
 */
export interface DiffWindow {
  /** The ref the diff was measured from. */
  since: string;
  /**
   * True when that ref is the commit the map records rather than a `--since`
   * the caller supplied, which is the difference between "since the map was
   * recorded at X" and "since X" -- and the sentence has to stay true for both.
   */
  recorded: boolean;
}

/**
 * The qualifier every file-naming reason shares, or nothing when there is no
 * window to name.
 *
 * One clause used three times rather than three sentences to keep in step, and
 * *appended* rather than woven in. Weaving it splits the phrase a reader and a
 * grep both key on -- `sentinel changed: pnpm-lock.yaml` becomes
 * `sentinel changed since ...: pnpm-lock.yaml` -- so the answer moves to make
 * room for the qualifier. Trailing, the answer stays where it was and the
 * window is what it is: a note about how the question was asked.
 *
 * The commit is abbreviated because it is a landmark here, not something to
 * copy.
 */
function measuredSince(window: DiffWindow | undefined): string {
  if (window === undefined) return '';
  return window.recorded
    ? ` (measured since the map was recorded at ${window.since.slice(0, 12)})`
    : ` (measured since ${window.since})`;
}

/**
 * covsel's own configuration, changed since the map was recorded.
 *
 * A map is only meaningful under the configuration it was recorded with.
 * Narrowing `sourceGlobs` is the sharpest case: changes outside the new globs
 * stop counting as changes at all, while the map's `observed` scope still
 * covers them from the wider recording, so nothing else notices and the tests
 * that cover those files are quietly skipped.
 *
 * "Recorded with" is a claim about values, and a map that recorded them is
 * asked exactly that: which fields differ from the configuration in force now.
 * That is both narrower and wider than reading the diff. A comment reworded, an
 * array reformatted, a key moved -- the file changed and the map still means
 * what it meant. A config computed from the environment, or one changed and
 * changed back across the recorded commit -- no file changed and the map does
 * not mean what selection is about to read.
 *
 * A map that recorded no configuration cannot be asked, and falls back to the
 * question the diff can answer: did a config file change at all. That is what
 * every map recorded before this existed gets, and it is today's behaviour.
 *
 * This is checked ahead of the project's own `sentinels` rather than added to
 * their defaults, because that list replaces wholesale when a project sets it —
 * and a project that tightens its sentinels should not lose the one that
 * protects the meaning of the map itself.
 */
function changedCovselConfig(
  config: CovselConfig,
  map: CoverageMap,
  changes: Change[],
  window?: DiffWindow,
): string | undefined {
  if (map.config === undefined) {
    const file = changes.find((c) => CONFIG_FILE_NAMES.has(c.file))?.file;
    return file === undefined
      ? undefined
      : `${file} changed, so the map was recorded under a different configuration${measuredSince(window)}`;
  }
  // No window on this one, and not an oversight: it compares the values the map
  // recorded against the values in force, which is not a diff at all. It already
  // names its own two states, and appending a second "since" would describe a
  // question it never asked.
  const fields = changedConfigFields(map.config, recordedConfig(config));
  return fields.length === 0
    ? undefined
    : `configuration changed since the map was recorded: ${fields.join(', ')}`;
}

/**
 * A note on the sentinel list, which this check deliberately leaves alone.
 *
 * Judging covsel's own config by its values does not extend to a config file a
 * project put in `sentinels`. covsel's defaults name no config file, so nobody
 * lists one to keep a default -- listing it is a deliberate declaration that a
 * change to that file runs everything, and the project may well have a reason
 * covsel cannot see from the values it reads: a test that loads the file as data
 * covers it in no way any recorder can observe. Second-guessing that declaration
 * would trade a guarantee the project asked for against CI minutes it already
 * decided to spend.
 *
 * The narrowing is still there for the asking, and is the default: drop the file
 * from `sentinels` and the check above -- which runs whatever the list says --
 * gives the sharper answer.
 */

/**
 * The first changed path the recording was not in a position to observe, if
 * any.
 *
 * Inside a map's `observed` globs, "no entry covers this file" is a measurement:
 * the recorder was watching and nothing ran. Outside them it is an artifact of
 * where the recorder was looking, and selecting on it skips tests the change can
 * break. So an unobserved change falls open instead.
 *
 * The globs are matched strictly. Every other glob set here is matched loosely,
 * because matching more of them runs more tests; this one is the exception, and
 * reading it loosely would let a path the recorder never covered pass as covered
 * and suppress the full run it should have caused.
 */
export function unobservedChange(
  map: CoverageMap,
  changes: Change[],
): string | undefined {
  const isObserved = makeStrictMatcher(map.observed);
  return changes.find((c) => !isObserved(c.file))?.file;
}

/**
 * Fail-open policy: every ambiguity resolves toward running more tests.
 *  - An unusable map, or one with no entries at all, forces a full run.
 *  - A change to the values in covsel's own config forces a full run: the map
 *    means what it means only under the config it was recorded with.
 *  - Any change to a sentinel file forces a full run.
 *  - A change outside what the recording could observe forces a full run.
 *  - Added/changed test files always run, even before they are in the map.
 */
export class FailOpenPolicy implements Policy {
  private readonly config: CovselConfig;
  private readonly isSentinel: (rel: string) => boolean;
  private readonly isTest: (rel: string) => boolean;

  constructor(config: CovselConfig) {
    this.config = config;
    this.isSentinel = makeMatcher(config.sentinels);
    this.isTest = makeMatcher(config.testGlobs);
  }

  evaluate(map: CoverageMap | undefined, changes: Change[]): 'select' | 'full-run' {
    if (!isUsableMap(map)) return 'full-run';
    // A map with no entries measured nothing, so its silence about a changed file
    // says nothing either. It is syntactically valid and structurally empty —
    // written by a recording that discovered no test files, or merged from
    // nothing — and reading it as "no test covers this" is how a run selects zero
    // tests and exits 0.
    if (map.entries.length === 0) return 'full-run';
    if (changedCovselConfig(this.config, map, changes) !== undefined) return 'full-run';
    if (changes.some((c) => this.isSentinel(c.file))) return 'full-run';
    if (unobservedChange(map, changes) !== undefined) return 'full-run';
    return 'select';
  }

  async mandatory(changes: Change[]): Promise<TestId[]> {
    return changes
      .filter((c) => (c.kind === 'added' || c.kind === 'modified') && this.isTest(c.file))
      .map((c) => ({ file: c.file }));
  }
}

/**
 * Human-readable reason a diff forces a full run (for logging/status).
 *
 * The map is taken as `unknown` because one of the answers here is about a map
 * that failed the schema check: typing it as a `CoverageMap` would make that
 * branch unreachable, and a caller holding a rejected map would have to invent
 * its own wording for the case this function already covers.
 */
export function fullRunReason(
  config: CovselConfig,
  map: unknown,
  changes: Change[],
  window?: DiffWindow,
): string {
  // Of the answers that follow, the three naming a changed file carry the
  // window. The three describing the map itself do not: none of them is about a
  // file having moved, and "no usable map recorded since origin/main" would be a
  // sentence about nothing.
  if (map === undefined) return 'no usable map recorded';
  if (!isUsableMap(map)) return 'recorded map is stale or has an incompatible schema';
  if (map.entries.length === 0) return 'map has no entries, so it measured nothing';
  const configChange = changedCovselConfig(config, map, changes, window);
  if (configChange !== undefined) return configChange;
  const isSentinel = makeMatcher(config.sentinels);
  const hit = changes.find((c) => isSentinel(c.file));
  if (hit) return `sentinel changed: ${hit.file}${measuredSince(window)}`;
  const unobserved = unobservedChange(map, changes);
  if (unobserved !== undefined) {
    return `${unobserved} changed, which the recording could not observe${measuredSince(window)}`;
  }
  return 'full run';
}
