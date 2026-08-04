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

  // A slash-less glob is matched against a path's basename anywhere in the tree,
  // which quietly pulls example and fixture directories into a project's source
  // set. Selection only widens as a result, so a run still measures something --
  // it just measures a source set nobody chose. Reject it at the door instead.
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
