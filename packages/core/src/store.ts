import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Store } from './interfaces.js';
import { type CoverageMap, isUsableMap } from './schema.js';

export interface LocalStoreInit {
  /** Repo root. */
  cwd: string;
  /** Store directory, relative to `cwd` (e.g. `.covsel`). */
  dir: string;
}

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

  async read(): Promise<CoverageMap | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return undefined;
    }
    return isUsableMap(parsed) ? parsed : undefined;
  }

  async write(map: CoverageMap): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(map, null, 2)}\n`);
  }

  async merge(): Promise<CoverageMap> {
    throw new Error('map merge is not implemented in this release');
  }
}
