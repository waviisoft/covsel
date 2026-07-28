import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  MAP_SCHEMA_VERSION,
  recordMap,
  resolveConfig,
  selectAffected,
  type TestId,
} from '@covsel/core';

import {
  type AdapterConformanceSpec,
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

function git(cwd: string, args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
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

function createProject(spec: AdapterConformanceSpec): Project {
  const cwd = mkdtempSync(join(tmpdir(), `covsel-conformance-${spec.adapter.name}-`));
  const dispose = (): void => rmSync(cwd, { recursive: true, force: true });
  try {
    for (const [rel, contents] of Object.entries(spec.fixture.files)) {
      writeFile(cwd, rel, contents);
    }
    // The sentinel check mutates package.json, so the suite owns it: a fixture
    // that supplies its own would make that mutation a silent no-op.
    if (spec.fixture.files['package.json']) {
      throw new Error(
        'a fixture must not supply package.json; the suite writes it so the sentinel check can mutate it',
      );
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
    return { cwd, config: resolveConfig(spec.fixture.config), dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

async function record(
  spec: AdapterConformanceSpec,
  project: Project,
): Promise<CoverageMap> {
  const recorder = spec.createRecorder({ cwd: project.cwd, config: project.config });
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
 * Hand a selection to the runner the way the adapter would and report which
 * units actually ran. Adapters that only emit a file list are exercised by
 * appending `formatSelection`'s output to the fixture command.
 */
function runSelected(
  spec: AdapterConformanceSpec,
  project: Project,
  selected: TestId[],
): { status: number; ran: string[] } {
  const marker = join(project.cwd, RAN_MARKER_FILE);
  rmSync(marker, { force: true });

  let status: number;
  if (spec.runSelection) {
    status = spec.runSelection({ selected, cwd: project.cwd });
  } else {
    const args = [
      ...spec.fixture.command.slice(1),
      ...spec.adapter.formatSelection(selected),
    ];
    const res = spawnSync(spec.fixture.command[0]!, args, {
      cwd: project.cwd,
      encoding: 'utf8',
    });
    status = res.status ?? 1;
  }

  const ran = existsSync(marker)
    ? readFileSync(marker, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    : [];
  return { status, ran };
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
        for (const unit of [a, b]) {
          if (!selects(result, unit)) {
            throw new Error(
              `editing ${spec.fixture.sharedSource} did not select ${label(unit)}, which executes it (selected ${JSON.stringify(result.selected)})`,
            );
          }
        }
        return result.fullRun ? `both, via a full run: ${result.reason}` : 'both units';
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

        const all = runSelected(spec, project, [
          { file: a.testFile, ...(a.name === undefined ? {} : { name: a.name }) },
          { file: b.testFile, ...(b.name === undefined ? {} : { name: b.name }) },
        ]);
        if (all.status !== 0) {
          throw new Error(`running both units exited ${all.status}`);
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
          throw new Error(`running the computed selection exited ${one.status}`);
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
