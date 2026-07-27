import { spawnSync } from 'node:child_process';
import {
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
} from '@covsel/core';

import type {
  AdapterConformanceSpec,
  ConformanceResult,
  ConformanceUnit,
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

function createProject(spec: AdapterConformanceSpec): Project {
  const cwd = mkdtempSync(join(tmpdir(), `covsel-conformance-${spec.adapter.name}-`));
  for (const [rel, contents] of Object.entries(spec.fixture.files)) {
    writeFile(cwd, rel, contents);
  }
  if (!spec.fixture.files['package.json']) {
    writeFile(
      cwd,
      'package.json',
      '{\n  "name": "fixture",\n  "private": true,\n  "type": "module"\n}\n',
    );
  }
  writeFile(cwd, '.gitignore', '.covsel/\nnode_modules/\n');
  if (spec.fixture.nodeModulesFrom) {
    symlinkSync(spec.fixture.nodeModulesFrom, join(cwd, 'node_modules'), 'dir');
  }
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'conformance@example.com']);
  git(cwd, ['config', 'user.name', 'covsel conformance']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'fixture']);
  return {
    cwd,
    config: resolveConfig(spec.fixture.config),
    dispose: () => rmSync(cwd, { recursive: true, force: true }),
  };
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

/** How a unit appears in a selection: its name when it has one, else its file. */
function labels(result: AffectedResult, unit: ConformanceUnit): string[] {
  return unit.name === undefined
    ? result.tests
    : result.selected.filter((t) => t.name !== undefined).map((t) => t.name!);
}

function identifies(result: AffectedResult, unit: ConformanceUnit): boolean {
  return labels(result, unit).includes(unit.name ?? unit.testFile);
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
    name: 'attributes each unit to the source it executes and not the other',
    run: async (spec) => {
      const project = createProject(spec);
      try {
        const map = await record(spec, project);
        const { a, b } = spec.fixture.units;
        for (const [unit, other] of [
          [a, b],
          [b, a],
        ] as const) {
          const covered = entriesFor(map, unit).map((f) => f.file);
          if (!covered.includes(unit.source)) {
            throw new Error(
              `${unit.name ?? unit.testFile} did not record ${unit.source} (got ${covered.join(', ') || 'nothing'})`,
            );
          }
          if (covered.includes(other.source)) {
            throw new Error(
              `${unit.name ?? unit.testFile} wrongly recorded ${other.source}, which it never executes`,
            );
          }
        }
        return 'no cross-contamination between the two units';
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
        const original = readFileSync(join(project.cwd, a.source), 'utf8');
        writeFile(project.cwd, a.source, `${original}\n// conformance edit\n`);

        const result = await selectAffected({ cwd: project.cwd, config: project.config });
        if (result.fullRun) {
          throw new Error(`a one-source edit forced a full run: ${result.reason}`);
        }
        if (!identifies(result, a)) {
          throw new Error(
            `editing ${a.source} did not select ${a.name ?? a.testFile} (selected ${JSON.stringify(result.selected)})`,
          );
        }
        if (identifies(result, b)) {
          throw new Error(
            `editing ${a.source} also selected ${b.name ?? b.testFile}, which never executes it`,
          );
        }
        return `selected only ${a.name ?? a.testFile}`;
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
