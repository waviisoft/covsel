import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repository-level checks on the adapters covsel ships.
 *
 * The conformance kit holds any adapter to its runtime contract. This holds the
 * ones in this repository to something the kit cannot see: that they read their
 * runner's coverage report through `@covsel/core` rather than carrying a private
 * copy of the reader.
 *
 * It lives here rather than in `@covsel/core`'s own suite, which has no business
 * reaching across packages to read a sibling's source.
 */

const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The adapters that record by reading an istanbul-shaped coverage report. */
const ISTANBUL_ADAPTERS = ['adapter-vitest', 'adapter-jest'] as const;

const sourceOf = (pkg: string): string =>
  readFileSync(join(packages, pkg, 'src', 'index.ts'), 'utf8');

describe('the adapters that read an istanbul report', () => {
  it.each(ISTANBUL_ADAPTERS)('%s reads it through core', (pkg) => {
    const source = sourceOf(pkg);
    expect(source).toContain('readIstanbulReport');
    expect(source).toContain('istanbulCoverage');
  });

  it.each(ISTANBUL_ADAPTERS)('%s declares no reader of its own', (pkg) => {
    // The entry shape and the block conversion derived from it are what drifted
    // apart while there were two copies. Deliberately not matching on bare
    // identifiers like `fnMap`, which an adapter might legitimately mention in a
    // comment explaining why it does not parse the report itself.
    const source = sourceOf(pkg);
    expect(source).not.toMatch(/interface CoverageFinalEntry/);
    expect(source).not.toMatch(/function blocksFor/);
  });
});
