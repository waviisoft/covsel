/**
 * @covsel/adapter-vitest — Vitest support for covsel.
 *
 * Vitest evaluates transformed sources through its own module runner, so raw
 * NODE_V8_COVERAGE at the process boundary never sees the original `src/**`
 * files. Instead this adapter records with Vitest's built-in V8 coverage
 * provider, which remaps execution back to sources through Vite's source maps,
 * and reads the resulting `coverage-final.json`. Selection formatting is a plain
 * file list, exactly like the generic wrap.
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
  positionToOffset,
  type Recorder,
  type RecordedTest,
  selectExecutedBlocks,
  type TestId,
  toRepoRelative,
} from '@covsel/core';

export const vitestAdapter: Adapter = {
  name: 'vitest',
  formatSelection(tests: TestId[]): string[] {
    return [...new Set(tests.map((t) => t.file))];
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

export interface VitestRecorderInit {
  /** Base command, e.g. `['vitest', 'run']`. */
  command: string[];
  cwd: string;
  config: Pick<CovselConfig, 'sourceGlobs' | 'testGlobs' | 'granularity'>;
  env?: NodeJS.ProcessEnv;
}

/**
 * A recorder that runs `<command> <testFile>` once with Vitest's V8 coverage
 * enabled and attributes the JSON report to that test file. Requires
 * `@vitest/coverage-v8` to be installed in the target project.
 */
export function createVitestRecorder(init: VitestRecorderInit): Recorder {
  const isSource = makeSourceFilter(init.config);
  const wantBlocks = init.config.granularity !== 'file';
  return {
    async record(testFile: string): Promise<RecordedTest> {
      const reportsDir = mkdtempSync(join(tmpdir(), 'covsel-vitest-'));
      const [bin, ...rest] = init.command;
      if (bin === undefined) throw new Error('empty command');
      try {
        const res = spawnSync(
          bin,
          [
            ...rest,
            testFile,
            '--coverage.enabled',
            '--coverage.provider=v8',
            '--coverage.reporter=json',
            `--coverage.reportsDirectory=${reportsDir}`,
            '--coverage.all=false',
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
            `vitest exited with ${res.status ?? 'signal'} while recording ${testFile}\n${output}`,
          );
        }

        let report: Record<string, CoverageFinalEntry>;
        try {
          report = JSON.parse(
            readFileSync(join(reportsDir, 'coverage-final.json'), 'utf8'),
          ) as Record<string, CoverageFinalEntry>;
        } catch {
          throw new Error(
            `no coverage report produced for ${testFile} — is @vitest/coverage-v8 installed?`,
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
        return { files, blocks };
      } finally {
        rmSync(reportsDir, { recursive: true, force: true });
      }
    },
  };
}
