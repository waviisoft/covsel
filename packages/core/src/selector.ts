import type { Change, Selector } from './interfaces.js';
import type { CoverageMap, TestId } from './schema.js';

/**
 * File-level selector: a map entry is affected when any source file it recorded
 * appears in the changed set. Block-level refinement (`changedBlockHashes`) is
 * intentionally ignored at file granularity.
 */
export class FileSelector implements Selector {
  async affected(map: CoverageMap, changes: Change[]): Promise<TestId[]> {
    const changed = new Set(changes.map((c) => c.file));
    const affected: TestId[] = [];
    for (const entry of map.entries) {
      if (entry.files.some((f) => changed.has(f.file))) affected.push(entry.test);
    }
    return affected;
  }
}
