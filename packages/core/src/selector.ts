import type { Change, Selector } from './interfaces.js';
import type { CoverageMap, TestId } from './schema.js';

/**
 * File-level selector, refined by block hashes when the diff provides them. A
 * map entry is affected when any source file it recorded appears in the changed
 * set — and, when that change carries `changedBlockHashes`, only if one of the
 * blocks the test actually executed is among them. Every ambiguity resolves
 * toward selecting: a change with no block information (undefined
 * `changedBlockHashes`), or an entry with no block data for the file, falls back
 * to file-level and is selected.
 */
export class FileSelector implements Selector {
  async affected(map: CoverageMap, changes: Change[]): Promise<TestId[]> {
    const byFile = new Map<string, Change>();
    for (const c of changes) byFile.set(c.file, c);

    const affected: TestId[] = [];
    for (const entry of map.entries) {
      let hit = false;
      for (const covered of entry.files) {
        const change = byFile.get(covered.file);
        if (!change) continue;
        if (change.changedBlockHashes === undefined) {
          hit = true; // file-level fallback: no block info for this change
          break;
        }
        const recorded = (entry.blocks ?? []).filter((b) => b.file === covered.file);
        if (recorded.length === 0) {
          hit = true; // entry has no block data for this file → file-level
          break;
        }
        const changed = new Set(change.changedBlockHashes);
        if (recorded.some((b) => changed.has(b.blockHash))) {
          hit = true;
          break;
        }
      }
      if (hit) affected.push(entry.test);
    }
    return affected;
  }
}
