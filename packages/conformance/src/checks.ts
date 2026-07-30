import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  type AffectedResult,
  type CoverageMap,
  type CovselConfig,
  type CovselConfigInput,
  extractBlocks,
  makeMatcher,
  makeStrictMatcher,
  MAP_SCHEMA_VERSION,
  MODULE_BLOCK,
  recordMap,
  resolveConfigFor,
  runSelected as runSelectedThroughAdapter,
  selectAffected,
  type TestId,
} from '@covsel/core';

import {
  type AdapterConformanceSpec,
  type ConformanceBlindSpot,
  type ConformanceResult,
  type ConformanceUnit,
  RAN_MARKER_FILE,
} from './spec.js';

/** A prepared fixture project on disk, plus the config the adapter records with. */
interface Project {
  cwd: string;
  config: CovselConfig;
  dispose(): void;
}

/** Explain why a spawn produced no clean exit, so a broken fixture is diagnosable. */
function spawnDetail(res: SpawnSyncReturns<string>): string {
  if (res.error) return res.error.message;
  if (res.signal) return `killed by ${res.signal}`;
  return (res.stderr || res.stdout || '').trim() || `exited ${res.status ?? 'unknown'}`;
}

function git(cwd: string, args: string[]): void {
  // Isolated from the contributor's global config: an ambient excludesFile,
  // hooksPath, or commit.gpgsign would break the fixture for reasons that have
  // nothing to do with the adapter under test.
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${spawnDetail(res)}`);
  }
}

function writeFile(cwd: string, rel: string, contents: string): void {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/** Append a comment to a source so the diff sees it change, without altering behaviour. */
function editSource(project: Project, rel: string): void {
  const original = readFileSync(join(project.cwd, rel), 'utf8');
  writeFile(project.cwd, rel, `${original}\n// conformance edit\n`);
}

/**
 * Apply a unit's `bodyEdit`, having first proved it really is a body edit: the
 * module skeleton must survive it and some function hash must not. An edit that
 * fails either test would exercise the same path as appending to the file, which
 * is what let a module-blocks-only recorder look correct.
 */
function editBody(project: Project, unit: ConformanceUnit): void {
  const { find, replace } = unit.bodyEdit;
  const before = readFileSync(join(project.cwd, unit.source), 'utf8');
  if (!before.includes(find)) {
    throw new Error(
      `${unit.source} does not contain the bodyEdit text ${JSON.stringify(find)}`,
    );
  }
  const after = before.replace(find, replace);
  const blocks = (source: string): Map<string, string> =>
    new Map(extractBlocks(source, unit.source).map((b) => [b.name, b.hash]));
  const [was, now] = [blocks(before), blocks(after)];
  if (was.get(MODULE_BLOCK) !== now.get(MODULE_BLOCK)) {
    throw new Error(
      `the bodyEdit for ${unit.source} changes the module skeleton; it must change only a function body, or it exercises the same path as appending to the file`,
    );
  }
  const changed = [...was].some(
    ([name, hash]) => name !== MODULE_BLOCK && now.get(name) !== hash,
  );
  if (!changed) {
    throw new Error(
      `the bodyEdit for ${unit.source} leaves every function hash intact; it must change a function body`,
    );
  }
  writeFile(project.cwd, unit.source, after);
}

/** Apply the blind spot's breaking edit, so running the units must now fail. */
function breakBlindSpot(project: Project, blind: ConformanceBlindSpot): void {
  const before = readFileSync(join(project.cwd, blind.source), 'utf8');
  const { find, replace } = blind.breakingEdit;
  // Re-read rather than trust the pre-flight: an edit that silently matched
  // nothing would leave the units passing and read as a blind spot they do not
  // execute, blaming the fixture for the wrong thing.
  if (!before.includes(find)) {
    throw new Error(
      `${blind.source} on disk does not contain the breakingEdit text ${JSON.stringify(find)}`,
    );
  }
  writeFile(project.cwd, blind.source, before.replace(find, replace));
}

/**
 * A blind spot can only demonstrate a fall-open if a change to it would not have
 * forced one anyway. A test file is selected by the mandatory rule and a
 * sentinel invalidates the map outright, whatever the recording observed, so
 * neither can show that the declared scope was what caused the full run.
 */
function assertBlindSpotIsChangeableCode(
  spec: AdapterConformanceSpec,
  config: CovselConfig,
): void {
  const blind = spec.fixture.blindSpot;
  if (blind === undefined) return;
  const contents = spec.fixture.files[blind.source];
  if (contents === undefined) {
    throw new Error(`the blindSpot ${blind.source} is not one of the fixture's files`);
  }
  const { find, replace } = blind.breakingEdit;
  if (!contents.includes(find)) {
    throw new Error(
      `${blind.source} does not contain the breakingEdit text ${JSON.stringify(find)}`,
    );
  }
  if (contents.replace(find, replace) === contents) {
    throw new Error(`the breakingEdit for ${blind.source} leaves the file unchanged`);
  }
  if (makeMatcher(config.testGlobs)(blind.source)) {
    throw new Error(
      `the blindSpot ${blind.source} is a test file, which is selected whether or not the recording could observe it`,
    );
  }
  if (makeMatcher(config.sentinels)(blind.source)) {
    throw new Error(
      `the blindSpot ${blind.source} is a sentinel, whose change forces a full run whatever the recording observed`,
    );
  }
}

/**
 * A fixture only measures recall if its shared source is reached *through* the
 * unit sources. If a test file names it, a recorder that never follows a
 * dependency still records it, and the recall checks certify nothing.
 */
function assertSharedSourceIsIndirect(spec: AdapterConformanceSpec): void {
  const { files, units, sharedSource } = spec.fixture;
  const reachedBy = new Set([units.a.source, units.b.source, sharedSource]);
  // The stem, not the basename: a TypeScript fixture imports `./shared.js` for
  // a file on disk called `shared.ts`, and matching the basename would miss it.
  const stem = sharedSource
    .split('/')
    .pop()!
    .replace(/\.[^.]+$/, '');
  for (const [rel, contents] of Object.entries(files)) {
    if (reachedBy.has(rel)) continue;
    if (contents.includes(stem)) {
      throw new Error(
        `${rel} mentions "${stem}": ${sharedSource} must be reached only through ${units.a.source} and ${units.b.source}, never named by a test file, or it measures no recall`,
      );
    }
  }
}

function createProject(
  spec: AdapterConformanceSpec,
  /** Fixture config overrides, for a check that needs a different setting. */
  override: CovselConfigInput = {},
): Project {
  assertSharedSourceIsIndirect(spec);
  // Resolved the way the CLI resolves it, so an adapter that supplies its own
  // test globs is discovered here with no fixture configuration, exactly as a
  // project running `covsel record --adapter <name>` would discover it.
  const config = resolveConfigFor(spec.adapter, {
    ...spec.fixture.config,
    ...override,
  });
  assertBlindSpotIsChangeableCode(spec, config);
  const cwd = realpathSync(
    mkdtempSync(
      join(tmpdir(), `covsel-conformance-${spec.adapter.name.replace(/\W+/g, '-')}-`),
    ),
  );
  const dispose = (): void => rmSync(cwd, { recursive: true, force: true });
  try {
    for (const [rel, contents] of Object.entries(spec.fixture.files)) {
      writeFile(cwd, rel, contents);
    }
    // The sentinel check mutates package.json and the marker file must stay
    // ignored, so the suite owns both: a fixture supplying either would make
    // those mechanisms silent no-ops.
    for (const owned of ['package.json', '.gitignore']) {
      if (owned in spec.fixture.files) {
        throw new Error(`a fixture must not supply ${owned}; the suite writes it`);
      }
    }
    writeFile(
      cwd,
      'package.json',
      '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
    );
    writeFile(cwd, '.gitignore', `.covsel/\nnode_modules/\n${RAN_MARKER_FILE}\n`);
    if (spec.fixture.nodeModulesFrom) {
      symlinkSync(spec.fixture.nodeModulesFrom, join(cwd, 'node_modules'), 'dir');
    }
    git(cwd, ['init', '-q', '-b', 'main']);
    git(cwd, ['config', 'user.email', 'conformance@example.com']);
    git(cwd, ['config', 'user.name', 'covsel conformance']);
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-q', '-m', 'fixture']);
    return { cwd, config, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

async function record(
  spec: AdapterConformanceSpec,
  project: Project,
): Promise<CoverageMap> {
  const recorder = spec.adapter.createRecorder({
    command: spec.fixture.command,
    cwd: project.cwd,
    config: project.config,
  });
  const result = await recordMap({ cwd: project.cwd, config: project.config, recorder });
  if (!result.ok || !result.map) {
    throw new Error(
      `recording failed: ${result.failures.map((f) => `${f.file}: ${f.reason}`).join('; ')}`,
    );
  }
  return result.map;
}

/** How this unit shows up in a marker file and in failure messages. */
function label(unit: ConformanceUnit): string {
  return unit.name ?? unit.testFile;
}

/** The selection id naming exactly this unit, and nothing else in its file. */
function idOf(unit: ConformanceUnit): TestId {
  return { file: unit.testFile, ...(unit.name === undefined ? {} : { name: unit.name }) };
}

/**
 * Whether running this selection would run this unit. A selected id with no
 * name means the whole file, which runs every unit in it — so a per-test adapter
 * cannot pass a precision check by emitting a redundant whole-file id alongside.
 */
function selects(result: AffectedResult, unit: ConformanceUnit): boolean {
  return result.selected.some(
    (t) => t.file === unit.testFile && (t.name === undefined || t.name === unit.name),
  );
}

/**
 * Hand a selection to the runner and report which units actually ran. This goes
 * through core's own dispatch — the adapter's native narrowing when it has one,
 * the formatted file list when it does not — so the invocation under test is the
 * invocation `covsel run` builds, not one shaped like it.
 */
function runSelected(
  spec: AdapterConformanceSpec,
  project: Project,
  selected: TestId[],
): { status: number; ran: string[]; detail: string } {
  const marker = join(project.cwd, RAN_MARKER_FILE);
  rmSync(marker, { force: true });

  const outcome = runSelectedThroughAdapter({
    adapter: spec.adapter,
    selected,
    command: spec.fixture.command,
    cwd: project.cwd,
    stdio: 'ignore',
  });

  const ran = existsSync(marker)
    ? readFileSync(marker, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    : [];
  return {
    status: outcome.status,
    ran,
    detail: outcome.output ?? `exited ${outcome.status}`,
  };
}

function mapPath(project: Project): string {
  return join(project.cwd, project.config.store.dir, 'map.json');
}

function entriesFor(map: CoverageMap, unit: ConformanceUnit): { file: string }[] {
  return map.entries
    .filter(
      (e) =>
        e.test.file === unit.testFile &&
        (unit.name === undefined || e.test.name === unit.name),
    )
    .flatMap((e) => e.files);
}

/**
 * Paths no fixture contains: a top-level file, a nested one, and a dotted
 * directory. A scope that matches paths it has never heard of is claiming the
 * whole repo, and nothing can lie outside it; one that does not is claiming a
 * part, and owes the suite the part it cannot see. Asking the globs this way
 * keeps the question about what a declaration means rather than how it is
 * spelled, which comparing it to `**` would not.
 */
const OUTSIDE_ANY_FIXTURE = [
  'covsel-scope-probe.txt',
  'nowhere/covsel-scope-probe.txt',
  '.covsel-scope-probe/deep/file.txt',
];

/** Whether a declared scope claims the whole repo rather than a part of it. */
function claimsEverything(isObserved: (rel: string) => boolean): boolean {
  return OUTSIDE_ANY_FIXTURE.every(isObserved);
}

type Check = (spec: AdapterConformanceSpec) => Promise<string>;

/**
 * The behaviours every adapter must exhibit. Each check throws with a reason on
 * failure and returns a short description of what it observed on success. They
 * are ordered cheapest-first so a broken adapter fails fast.
 */
const CHECKS: { name: string; run: Check }[] = [
  {
    name: 'formatSelection emits a deduplicated file list',
    run: async (spec) => {
      const out = spec.adapter.formatSelection([
        { file: 'x', name: 'one' },
        { file: 'x', name: 'two' },
        { file: 'y' },
      ]);
      if (JSON.stringify(out) !== JSON.stringify(['x', 'y'])) {
        throw new Error(`expected ["x","y"], got ${JSON.stringify(out)}`);
      }
      if (spec.adapter.formatSelection([]).length !== 0) {
        throw new Error('an empty selection must format to an empty list');
      }
      return 'collapses per-test ids of one file and handles the empty selection';
    },
  },
  {
    name: 'records a usable map covering every discovered test',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        const map = await record(spec, project);
        if (map.schemaVersion !== MAP_SCHEMA_VERSION) {
          throw new Error(`map schemaVersion is ${map.schemaVersion}`);
        }
        for (const unit of [spec.fixture.units.a, spec.fixture.units.b]) {
          if (entriesFor(map, unit).length === 0) {
            throw new Error(`no entry recorded for ${unit.name ?? unit.testFile}`);
          }
        }
        return `${map.entries.length} entries`;
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'attributes each unit to every source it executes and to no other',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        const map = await record(spec, project);
        const { a, b } = spec.fixture.units;
        const { sharedSource } = spec.fixture;
        for (const [unit, other] of [
          [a, b],
          [b, a],
        ] as const) {
          const covered = entriesFor(map, unit).map((f) => f.file);
          for (const source of [unit.source, sharedSource]) {
            if (!covered.includes(source)) {
              throw new Error(
                `${label(unit)} did not record ${source}, which it executes (got ${covered.join(', ') || 'nothing'})`,
              );
            }
          }
          if (covered.includes(other.source)) {
            throw new Error(
              `${label(unit)} wrongly recorded ${other.source}, which it never executes`,
            );
          }
        }
        return 'each unit records its own source and the shared one, and nothing else';
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'records the same coverage when run twice',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        const shape = (map: CoverageMap): string =>
          JSON.stringify(
            map.entries
              .map((e) => ({
                test: e.test,
                files: e.files.map((f) => f.file).sort(),
                blocks: (e.blocks ?? []).map((b) => `${b.file} ${b.blockHash}`).sort(),
              }))
              .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
          );
        const first = shape(await record(spec, project));
        const second = shape(await record(spec, project));
        if (first !== second) {
          throw new Error('a second recording produced different coverage');
        }
        return 'coverage is stable across reruns';
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'editing one source selects its unit and not the other',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        await record(spec, project);
        const { a, b } = spec.fixture.units;
        editSource(project, a.source);

        const result = await selectAffected({ cwd: project.cwd, config: project.config });
        if (result.fullRun) {
          throw new Error(`a one-source edit forced a full run: ${result.reason}`);
        }
        if (!selects(result, a)) {
          throw new Error(
            `editing ${a.source} did not select ${label(a)} (selected ${JSON.stringify(result.selected)})`,
          );
        }
        if (selects(result, b)) {
          throw new Error(
            `editing ${a.source} also selected ${label(b)}, which never executes it (selected ${JSON.stringify(result.selected)})`,
          );
        }
        return `selected only ${label(a)}`;
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'editing a shared source selects both units',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        await record(spec, project);
        const { a, b } = spec.fixture.units;
        editSource(project, spec.fixture.sharedSource);

        const result = await selectAffected({ cwd: project.cwd, config: project.config });
        // A full run selects everything, so it would satisfy the assertion below
        // while proving nothing about what was recorded. Recall has to be shown
        // through the map, not around it.
        if (result.fullRun) {
          throw new Error(
            `editing ${spec.fixture.sharedSource} fell open (${result.reason}), so this fixture cannot demonstrate recall`,
          );
        }
        for (const unit of [a, b]) {
          if (!selects(result, unit)) {
            throw new Error(
              `editing ${spec.fixture.sharedSource} did not select ${label(unit)}, which reaches it through ${unit.source} (selected ${JSON.stringify(result.selected)})`,
            );
          }
        }
        return 'both units';
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'editing a function body selects the unit that ran it',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        const map = await record(spec, project);
        const { a, b } = spec.fixture.units;
        editBody(project, a);

        const result = await selectAffected({ cwd: project.cwd, config: project.config });
        if (result.fullRun) {
          throw new Error(`a function-body edit forced a full run: ${result.reason}`);
        }
        if (!selects(result, a)) {
          throw new Error(
            `changing a function body in ${a.source} did not select ${label(a)}, which executes it — ` +
              `at ${map.granularity} granularity that is a change the map missed (selected ${JSON.stringify(result.selected)})`,
          );
        }
        if (selects(result, b)) {
          throw new Error(
            `changing a function body in ${a.source} also selected ${label(b)}, which never executes it`,
          );
        }
        return `${map.granularity} granularity: selected only ${label(a)}`;
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'a selection handed to the runner runs the units it names',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        await record(spec, project);
        const { a, b } = spec.fixture.units;

        const all = runSelected(spec, project, [idOf(a), idOf(b)]);
        if (all.status !== 0) {
          throw new Error(`running both units failed: ${all.detail}`);
        }
        for (const unit of [a, b]) {
          if (!all.ran.includes(label(unit))) {
            throw new Error(
              `selecting both units did not run ${label(unit)} (ran ${all.ran.join(', ') || 'nothing'}); ` +
                `every unit must append its label to ${RAN_MARKER_FILE} when it runs`,
            );
          }
        }

        editSource(project, a.source);
        const result = await selectAffected({ cwd: project.cwd, config: project.config });
        const one = runSelected(spec, project, result.selected);
        if (one.status !== 0) {
          throw new Error(`running the computed selection failed: ${one.detail}`);
        }
        if (!one.ran.includes(label(a))) {
          throw new Error(
            `the selection for an edit to ${a.source} ran ${one.ran.join(', ') || 'nothing'}, not ${label(a)}`,
          );
        }
        if (one.ran.includes(label(b))) {
          throw new Error(
            `the selection for an edit to ${a.source} also ran ${label(b)}; the runner is not honouring it`,
          );
        }
        return `ran exactly ${one.ran.join(', ')}`;
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'a test added after recording always runs',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        await record(spec, project);
        writeFile(project.cwd, spec.fixture.newTest.file, spec.fixture.newTest.contents);
        const result = await selectAffected({ cwd: project.cwd, config: project.config });
        if (!result.tests.includes(spec.fixture.newTest.file)) {
          throw new Error(
            `${spec.fixture.newTest.file} was not selected (got ${result.tests.join(', ') || 'nothing'})`,
          );
        }
        return 'an unmapped new test is selected';
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'a sentinel change runs everything',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        await record(spec, project);
        const pkg = readFileSync(join(project.cwd, 'package.json'), 'utf8');
        writeFile(
          project.cwd,
          'package.json',
          pkg.replace('"fixture"', '"fixture-changed"'),
        );
        const result = await selectAffected({ cwd: project.cwd, config: project.config });
        if (!result.fullRun) {
          throw new Error('changing package.json did not force a full run');
        }
        for (const unit of [spec.fixture.units.a, spec.fixture.units.b]) {
          if (!result.tests.includes(unit.testFile)) {
            throw new Error(`a full run omitted ${unit.testFile}`);
          }
        }
        return `full run: ${result.reason}`;
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'an unusable map runs everything',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        await record(spec, project);
        const map = JSON.parse(readFileSync(mapPath(project), 'utf8')) as CoverageMap;
        writeFileSync(
          mapPath(project),
          JSON.stringify({ ...map, schemaVersion: MAP_SCHEMA_VERSION - 1 }),
        );
        const result = await selectAffected({ cwd: project.cwd, config: project.config });
        if (!result.fullRun) {
          throw new Error('a wrong-schema map did not force a full run');
        }
        if (result.tests.length === 0) {
          throw new Error('a wrong-schema map selected nothing at all');
        }
        return `full run: ${result.reason}`;
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: 'a recorder records only what it can observe, and its blind spots fall open',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        const map = await record(spec, project);
        const isObserved = makeStrictMatcher(map.observed);
        const scope = map.observed.join(', ') || 'nothing';
        const { a, b } = spec.fixture.units;

        // Every other check certifies what the adapter recorded; this one holds
        // the recording to what it says it was in a position to record. Coverage
        // outside the declared scope is never read, so reporting it means the
        // declaration describes something other than what this recorder watches.
        for (const entry of map.entries) {
          const recorded = [
            ...entry.files.map((f) => f.file),
            ...(entry.blocks ?? []).map((blk) => blk.file),
          ];
          const outside = recorded.find((file) => !isObserved(file));
          if (outside !== undefined) {
            throw new Error(
              `${entry.test.name ?? entry.test.file} recorded ${outside}, outside the scope this recorder declares it observes (${scope}). ` +
                `Coverage there is never read, so drop it; widen the declaration only if code running there really would have been seen`,
            );
          }
        }

        const blind = spec.fixture.blindSpot;
        if (!claimsEverything(isObserved)) {
          // Asked of the declaration, not of the fixture's file list. A file no
          // unit executes — a README, a config — says nothing about what the
          // recorder can see, so demanding a blind spot because one sits outside
          // the scope rejects a correct adapter, and demanding none because
          // every file happens to sit inside lets a narrow claim go untested.
          if (blind === undefined) {
            throw new Error(
              `this recorder declares it observes only ${scope}, and the fixture has no blindSpot. ` +
                `A fixture whose units execute nothing outside the declaration never exercises it, so a recorder blind past it passes every check`,
            );
          }
          if (isObserved(blind.source)) {
            throw new Error(
              `the blindSpot ${blind.source} is inside ${scope}, the scope this recorder declares. ` +
                `Nothing this fixture executes then lies outside the declaration, so the fall-open it exists to demonstrate is never reached`,
            );
          }
        }
        if (blind === undefined) {
          return `records only within ${scope}, which is everything`;
        }

        // Prove the blind spot is load-bearing before reading anything into it,
        // and prove it by difference. A non-zero exit on its own means only that
        // something failed — a runner that runs no tests and reports failure
        // produces the same one — so the units are first shown passing, and
        // shown running, with the fixture whole.
        const whole = runSelected(spec, project, [idOf(a), idOf(b)]);
        const missing = [a, b].filter((unit) => !whole.ran.includes(label(unit)));
        if (whole.status !== 0 || missing.length > 0) {
          throw new Error(
            `both units must run and pass before the blind spot is broken, or breaking it proves nothing; ` +
              `ran ${whole.ran.join(', ') || 'nothing'} (${whole.detail})`,
          );
        }
        breakBlindSpot(project, blind);
        const broken = runSelected(spec, project, [idOf(a), idOf(b)]);
        if (broken.status === 0) {
          throw new Error(
            `both units still pass with ${blind.source} broken, so they do not execute it; ` +
              `a blindSpot nothing reaches cannot show what a recorder missed`,
          );
        }

        if (isObserved(blind.source)) {
          // The recorder claims this ground. A partial view of the run declared
          // as a whole one is the shape this check exists for: what it reports
          // is plausible, deterministic, and precise, and the only thing wrong
          // with it is a region of the codebase it was never watching.
          for (const unit of [a, b]) {
            if (!entriesFor(map, unit).some((f) => f.file === blind.source)) {
              throw new Error(
                `${label(unit)} executes ${blind.source}, which the declared scope (${scope}) covers, yet nothing of it was recorded. ` +
                  `A recorder that sees only part of a run has to declare only what it sees, or selection reads its blind spot as "this code ran nowhere"`,
              );
            }
          }
          return `observes ${scope}, and recorded ${blind.source}, which both units execute`;
        }

        const result = await selectAffected({ cwd: project.cwd, config: project.config });
        if (!result.fullRun) {
          throw new Error(
            `${blind.source} changed, which this recorder declared it could not observe (${scope}), and selection did not fall open (selected ${JSON.stringify(result.selected)})`,
          );
        }
        if (!(result.reason ?? '').includes(blind.source)) {
          throw new Error(
            `changing ${blind.source} forced a full run for an unrelated reason (${result.reason}), which shows nothing about what the recording could observe`,
          );
        }
        for (const unit of [a, b]) {
          if (!result.tests.includes(unit.testFile)) {
            throw new Error(`the full run omitted ${unit.testFile}`);
          }
        }
        return `full run: ${result.reason}`;
      } finally {
        project.dispose();
      }
    },
  },
  {
    name: "an adapter that defers its report to covsel gets covsel's reading of it",
    run: async (spec) => {
      // Only for adapters that declare `coverageReport`. Everyone else obtains
      // coverage some other way, and there is no deferral to hold them to.
      if (spec.adapter.coverageReport === undefined) {
        return 'not applicable: this adapter does not defer a report to covsel';
      }

      // The declaration says covsel's reader decides what the report credits,
      // and the reader reads the same config as everything else. Granularity is
      // where that is observable from outside: asked for file granularity, an
      // adapter using covsel's reader emits no blocks, while one that kept its
      // own reading of the report has to have remembered to. That is exactly the
      // setting a second, private copy of the reader forgets -- and the drift is
      // invisible until a map narrows by blocks it should not have.
      const project = createProject(spec, { granularity: 'file' });
      try {
        const recorder = spec.adapter.createRecorder({
          command: spec.fixture.command,
          cwd: project.cwd,
          config: project.config,
        });
        const units = await recorder.record(spec.fixture.units.a.testFile);
        const withBlocks = units.filter((u) => u.blocks.length > 0);
        if (withBlocks.length > 0) {
          const first = withBlocks[0]!;
          throw new Error(
            `asked for file granularity, this recorder still reported ${first.blocks.length} block(s) for ` +
              `${first.test.name ?? first.test.file}. An adapter declaring coverageReport '${spec.adapter.coverageReport}' ` +
              `defers to covsel's reader, which reads granularity from the same config -- reporting blocks anyway means ` +
              `something else is interpreting the report`,
          );
        }
        return `honours file granularity, so covsel's reading of its ${spec.adapter.coverageReport} report is what counts`;
      } finally {
        project.dispose();
      }
    },
  },
];

/** Names of every check in the suite, in the order they run. */
export const conformanceCheckNames: string[] = CHECKS.map((c) => c.name);

/** Run one check by name. Throws if the name is unknown. */
export async function runConformanceCheck(
  spec: AdapterConformanceSpec,
  name: string,
): Promise<string> {
  const check = CHECKS.find((c) => c.name === name);
  if (!check) throw new Error(`unknown conformance check: ${name}`);
  return check.run(spec);
}

/**
 * Run the whole suite and report every check, without assuming a test
 * framework. In-repo adapters use the vitest binding instead, which reports each
 * check as its own test.
 */
export async function runAdapterConformance(
  spec: AdapterConformanceSpec,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const check of CHECKS) {
    try {
      results.push({ check: check.name, ok: true, detail: await check.run(spec) });
    } catch (err) {
      results.push({
        check: check.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
