/**
 * A benchmark project: everything a replay needs to clone a real repository,
 * make covsel work on it, and run its suite the way its maintainers do.
 *
 * Projects are data rather than code so that adding one is a change to a JSON
 * file. A project whose configuration cannot be expressed here is a gap worth
 * knowing about, not a reason to special-case it in the harness.
 */

/** covsel's own configuration, as written into the clone. */
export interface ProjectCovselConfig {
  testGlobs?: string[];
  sourceGlobs?: string[];
  alwaysRun?: string[];
  sentinels?: string[];
}

export interface BenchmarkProject {
  /** Short identifier; also the name of the results file. */
  name: string;
  /** GitHub `owner/repo` to clone. */
  repo: string;
  /** The commit a replay records its map on. Pinned so results are comparable. */
  ref: string;
  /** Adapter package installed into the clone, e.g. `@covsel/adapter-generic`. */
  adapter: string;
  /** What to pass to `covsel record --adapter`. */
  adapterName: string;
  /** Command that installs the project's own dependencies. */
  install: string[];
  /**
   * The runner command covsel wraps. Recording appends one test file to it, so
   * it must be a command that accepts a single test file as its last argument.
   */
  runner: string[];
  /** Written into the clone as `covsel.json`. */
  covsel: ProjectCovselConfig;
  /** Why this project is in the slate, for the published results table. */
  rationale?: string;
}

class ProjectConfigError extends Error {}

function requireString(
  value: unknown,
  field: string,
  source: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectConfigError(
      `${source}: '${field}' must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
}

function requireCommand(
  value: unknown,
  field: string,
  source: string,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== 'string' || part.trim() === '')
  ) {
    throw new ProjectConfigError(
      `${source}: '${field}' must be a non-empty array of non-empty strings, ` +
        `got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Read a project definition, rejecting anything a replay could not act on.
 *
 * Validation is strict on purpose: a replay clones a repository and runs its
 * whole suite several times, so a typo that only surfaces an hour in costs more
 * than every check here put together.
 */
export function parseProject(raw: unknown, source: string): BenchmarkProject {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectConfigError(`${source}: expected a JSON object`);
  }
  const value = raw as Record<string, unknown>;

  requireString(value.name, 'name', source);
  requireString(value.repo, 'repo', source);
  requireString(value.ref, 'ref', source);
  requireString(value.adapter, 'adapter', source);
  requireString(value.adapterName, 'adapterName', source);
  requireCommand(value.install, 'install', source);
  requireCommand(value.runner, 'runner', source);

  // A full commit SHA, never a branch or tag. The point of the field is that a
  // rerun measures the same tree; a moving ref would let two runs disagree with
  // no sign in the results that they measured different code.
  if (!/^[0-9a-f]{40}$/.test(value.ref)) {
    throw new ProjectConfigError(
      `${source}: 'ref' must be a full 40-character commit SHA so a rerun ` +
        `measures the same tree, got ${JSON.stringify(value.ref)}`,
    );
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(value.repo)) {
    throw new ProjectConfigError(
      `${source}: 'repo' must be 'owner/name', got ${JSON.stringify(value.repo)}`,
    );
  }

  const covselRaw = value.covsel ?? {};
  if (typeof covselRaw !== 'object' || covselRaw === null || Array.isArray(covselRaw)) {
    throw new ProjectConfigError(`${source}: 'covsel' must be an object`);
  }
  const covsel = covselRaw as ProjectCovselConfig;

  // Required, never defaulted. covsel fills an unset `testGlobs` from the
  // adapter's own defaults, which the harness does not consult when it discovers
  // the suite -- so leaving it unset lets the two disagree about which files the
  // suite even contains. For an adapter whose defaults are feature files, the
  // harness would discover none and score a clean, zero-miss result for a
  // project it never measured.
  if (!Array.isArray(covsel.testGlobs) || covsel.testGlobs.length === 0) {
    throw new ProjectConfigError(
      `${source}: 'covsel.testGlobs' must be set explicitly, so that the harness ` +
        `and covsel agree on which files the suite contains -- covsel would ` +
        `otherwise fill it from the adapter's defaults, which the harness does ` +
        `not see`,
    );
  }

  // A slash-less glob is matched against a path's basename anywhere in the tree
  // for `testGlobs`, `sentinels`, and `alwaysRun`, which quietly pulls example
  // and fixture directories into what a project counts. Selection only widens as
  // a result, so a run still measures something -- it just measures a set nobody
  // chose. Rejected at the door instead.
  //
  // `sourceGlobs` no longer widens that way (covsel/covsel#20), so for that field
  // this is house style rather than a guard: benchmark data reads better for one
  // rule across every field than for one with an exception, and a project author
  // writing a path they mean loses nothing by the `/`.
  for (const [field, globs] of Object.entries(covsel)) {
    if (!Array.isArray(globs)) continue;
    for (const glob of globs) {
      if (typeof glob === 'string' && !glob.includes('/')) {
        throw new ProjectConfigError(
          `${source}: covsel.${field} entry ${JSON.stringify(glob)} has no '/', ` +
            `which also matches that basename anywhere in the tree -- ` +
            `write it as a path (e.g. '${glob}' -> './${glob}' or '**/${glob}')`,
        );
      }
    }
  }

  return {
    name: value.name,
    repo: value.repo,
    ref: value.ref,
    adapter: value.adapter,
    adapterName: value.adapterName,
    install: value.install,
    runner: value.runner,
    covsel,
    ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}),
  };
}
