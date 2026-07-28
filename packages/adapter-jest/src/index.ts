/**
 * @covsel/adapter-jest — Jest support for covsel.
 *
 * Jest evaluates code through its own transformer and module registry, so raw
 * NODE_V8_COVERAGE at the process boundary cannot be trusted for Jest. The dump
 * does name the original files, which makes it look usable, but the offsets in
 * it address the *transformed* module source: a function in a small source file
 * is reported at ranges past that file's end, and any block hashed from those
 * ranges is meaningless. Instead this adapter records with Jest's own coverage,
 * which remaps execution back to sources through the transformer's source maps,
 * and reads the resulting istanbul-shaped `coverage-final.json`. Selection
 * formatting is a plain file list, exactly like the generic wrap.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Adapter,
  type CoveredBlock,
  type CoveredFile,
  type CovselConfig,
  type ExecRegion,
  hashFileContents,
  makeSourceFilter,
  OBSERVES_EVERYTHING,
  positionToOffset,
  type Recorder,
  type RecordedUnit,
  type RecorderInit,
  selectExecutedBlocks,
  type TestId,
  toRepoRelative,
} from '@covsel/core';

export const jestAdapter: Adapter = {
  name: 'jest',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
  },
  createRecorder(init: RecorderInit): Recorder {
    return createJestRecorder(init);
  },
};

interface IstanbulPosition {
  line: number;
  column: number;
}

/** One file's entry in an istanbul-shaped `coverage-final.json`. */
interface CoverageFinalEntry {
  path?: string;
  s?: Record<string, number>;
  f?: Record<string, number>;
  b?: Record<string, number[]>;
  fnMap?: Record<string, { loc?: { start: IstanbulPosition; end: IstanbulPosition } }>;
}

function executed(entry: CoverageFinalEntry): boolean {
  const anyCount = (counts?: Record<string, number>): boolean =>
    counts !== undefined && Object.values(counts).some((c) => c > 0);
  const anyBranch = (b?: Record<string, number[]>): boolean =>
    b !== undefined && Object.values(b).some((arr) => arr.some((c) => c > 0));
  return anyCount(entry.s) || anyCount(entry.f) || anyBranch(entry.b);
}

/** Executed blocks of one source, from its istanbul function map + hit counts. */
function blocksFor(entry: CoverageFinalEntry, rel: string, abs: string): CoveredBlock[] {
  let source: string;
  try {
    source = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const toOffset = positionToOffset(source);
  const regions: ExecRegion[] = [];
  for (const [id, fn] of Object.entries(entry.fnMap ?? {})) {
    if (!fn.loc) continue;
    regions.push({
      start: toOffset(fn.loc.start.line, fn.loc.start.column),
      end: toOffset(fn.loc.end.line, fn.loc.end.column),
      count: entry.f?.[id] ?? 0,
    });
  }
  return selectExecutedBlocks(source, rel, regions).map((b) => ({
    file: rel,
    blockHash: b.hash,
  }));
}

export interface JestRecorderInit {
  /** Base command, e.g. `['jest']`. */
  command: string[];
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs' | 'granularity'>;
  env?: NodeJS.ProcessEnv;
}

/**
 * A recorder that runs `<command> <testFile>` once with Jest's coverage enabled
 * and attributes the JSON report to that test file. Coverage is built into Jest,
 * so no extra dependency is needed in the target project.
 */
export function createJestRecorder(init: JestRecorderInit): Recorder {
  const isSource = makeSourceFilter(init.config);
  const wantBlocks = init.config.granularity !== 'file';
  return {
    // Jest's coverage reports every module its registry loaded, remapped to the
    // original file, so any source under the repo that a test reaches shows up
    // in the report regardless of where it lives.
    observes: OBSERVES_EVERYTHING,
    async record(testFile: string): Promise<RecordedUnit[]> {
      const reportsDir = mkdtempSync(join(tmpdir(), 'covsel-jest-'));
      const [bin, ...rest] = init.command;
      if (bin === undefined) throw new Error('empty command');
      try {
        const res = spawnSync(
          bin,
          [
            ...rest,
            '--coverage',
            '--coverageReporters=json',
            `--coverageDirectory=${reportsDir}`,
            // Recording observes one test file at a time, which trips any
            // coverage threshold the project configured for a whole run.
            // Observation is not a quality gate, so neutralize them.
            '--coverageThreshold={}',
            // Bare positional arguments are regexes matched against every test
            // path, so a path can pull in files it merely resembles and
            // contaminate this file's entry. This makes the match exact.
            '--runTestsByPath',
            testFile,
          ],
          {
            cwd: init.cwd,
            env: { ...process.env, ...init.env },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        if (res.error) throw res.error;
        if (res.status !== 0) {
          const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
          throw new Error(
            `jest exited with ${res.status ?? 'signal'} while recording ${testFile}\n${output}`,
          );
        }

        let report: Record<string, CoverageFinalEntry>;
        try {
          report = JSON.parse(
            readFileSync(join(reportsDir, 'coverage-final.json'), 'utf8'),
          ) as Record<string, CoverageFinalEntry>;
        } catch {
          throw new Error(
            `no coverage report produced for ${testFile} — does the jest config ` +
              `override coverageReporters or coverageDirectory?`,
          );
        }

        const files: CoveredFile[] = [];
        const blocks: CoveredBlock[] = [];
        const seenFile = new Set<string>();
        for (const [key, entry] of Object.entries(report)) {
          const abs = entry.path ?? key;
          const rel = toRepoRelative(init.cwd, abs);
          if (rel === undefined || !isSource(rel) || seenFile.has(rel)) continue;
          if (!executed(entry)) continue;
          seenFile.add(rel);
          files.push({ file: rel, fileHash: hashFileContents(abs) });
          if (wantBlocks) blocks.push(...blocksFor(entry, rel, abs));
        }
        files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
        return [{ test: { file: testFile }, files, blocks }];
      } finally {
        rmSync(reportsDir, { recursive: true, force: true });
      }
    },
  };
}
