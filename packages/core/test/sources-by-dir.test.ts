import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  computeStatus,
  type MapEntry,
  MAP_SCHEMA_VERSION,
  resolveConfig,
} from '../src/index.js';

/**
 * Where a map's covered sources came from, as `status` reports it.
 *
 * `sources: 29` is the number people read to judge whether their `sourceGlobs`
 * say what they meant, and on its own it cannot answer that. The case this
 * exists for is measured: `expressjs/express` recorded 29 covered sources for a
 * library with 7, the other 22 example apps pulled in by a glob that matched
 * more than it said. Nothing short of opening the map file showed it.
 *
 * covsel/covsel#20 stops that particular glob widening. This is the other half:
 * a project whose sources come from somewhere it did not intend can still see so
 * at a glance, whatever put them there.
 */

const config = resolveConfig();
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A project whose map credits one entry with the given sources. */
function project(sources: string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-bydir-'));
  dirs.push(cwd);
  const entry: MapEntry = {
    test: { file: 'test/a.test.js' },
    files: sources.map((file) => ({ file, fileHash: `sha256:${file}` })),
  };
  mkdirSync(join(cwd, '.covsel'), { recursive: true });
  writeFileSync(
    join(cwd, '.covsel', 'map.json'),
    JSON.stringify({
      schemaVersion: MAP_SCHEMA_VERSION,
      granularity: 'file',
      recordedAt: '2026-07-01T00:00:00.000Z',
      sentinelHashes: {},
      observed: ['**'],
      entries: [entry],
    }),
  );
  return cwd;
}

describe('covered sources by directory', () => {
  it('counts them by top-level directory, biggest first', async () => {
    // The express shape, shrunk: a little real source and a lot of examples.
    const cwd = project([
      'lib/application.js',
      'lib/router.js',
      'examples/auth/index.js',
      'examples/mvc/index.js',
      'examples/vhost/index.js',
    ]);

    const status = await computeStatus({ cwd, config });

    expect(status.coveredFileCount).toBe(5);
    // Biggest first, because the directory nobody meant to include is usually
    // the one that grew the count.
    expect(Object.entries(status.coveredSourcesByDir ?? {})).toEqual([
      ['examples', 3],
      ['lib', 2],
    ]);
  });

  it('calls the repository root `.`', async () => {
    const cwd = project(['index.js', 'lib/router.js']);

    const status = await computeStatus({ cwd, config });

    expect(status.coveredSourcesByDir).toEqual({ '.': 1, lib: 1 });
  });

  it('breaks ties by name, so the report does not depend on the filesystem', async () => {
    // The map is read from a file and its entries are walked in order; two
    // directories with the same count must not swap between runs or machines.
    const cwd = project(['zeta/a.js', 'alpha/b.js']);

    const status = await computeStatus({ cwd, config });

    expect(Object.keys(status.coveredSourcesByDir ?? {})).toEqual(['alpha', 'zeta']);
  });

  it('is empty for a map that credits no source at all', async () => {
    const cwd = project([]);

    const status = await computeStatus({ cwd, config });

    expect(status.coveredSourcesByDir).toEqual({});
  });
});
