import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Store } from './interfaces.js';
import { mergeMaps } from './merge.js';
import { type CoverageMap, mapRejection } from './schema.js';

export interface LocalStoreInit {
  /** Repo root. */
  cwd: string;
  /** Store directory, relative to `cwd` (e.g. `.covsel`). */
  dir: string;
}

/**
 * What the store holds, told apart for the commands that have to explain covsel
 * rather than obey it.
 *
 * `absent` is no file at the path. `unusable` is a file that is there and cannot
 * be believed — unreadable, unparseable, or a map this build does not accept —
 * and carries the reason and whatever parsed out of it. `usable` is a map
 * selection may narrow with.
 */
export type StoredMap =
  | { state: 'absent' }
  | { state: 'unusable'; reason: string; map: unknown }
  | { state: 'usable'; map: CoverageMap };

/**
 * Local JSON store: a single `map.json` under the store directory. A missing,
 * unparseable, or wrong-schema map reads back as `undefined` — which callers
 * must treat as "run everything", never "run nothing".
 */
export class LocalStore implements Store {
  private readonly file: string;

  constructor(init: LocalStoreInit) {
    this.file = join(init.cwd, init.dir, 'map.json');
  }

  /** Absolute path of the map file. */
  path(): string {
    return this.file;
  }

  /**
   * The map as a diagnostic sees it: present or not, usable or not, and why not.
   *
   * `read()` is the selection path and answers the only question selection may
   * ask, which is why it collapses all three of those into `undefined`. A
   * command that reports a present-but-rejected map as a missing one sends its
   * reader to look for a file that is sitting right there, so the distinction is
   * drawn here — beside the selection read and defining it, never in a second
   * opinion about usability that could come to disagree with it.
   */
  inspect(): StoredMap {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
      const detail = e instanceof Error ? e.message : String(e);
      return {
        state: 'unusable',
        reason: `the map file could not be read: ${detail}`,
        map: undefined,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return {
        state: 'unusable',
        reason: `the map file is not valid JSON: ${detail}`,
        map: undefined,
      };
    }
    const rejection = mapRejection(parsed);
    return rejection === undefined
      ? { state: 'usable', map: parsed as CoverageMap }
      : { state: 'unusable', reason: rejection, map: parsed };
  }

  async read(): Promise<CoverageMap | undefined> {
    const stored = this.inspect();
    return stored.state === 'usable' ? stored.map : undefined;
  }

  async write(map: CoverageMap): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(map, null, 2)}\n`);
  }

  async merge(maps: CoverageMap[]): Promise<CoverageMap> {
    return mergeMaps(maps);
  }
}
