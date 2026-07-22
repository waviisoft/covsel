import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The per-test bet: snapshot V8 precise coverage before and after each *test* via
 * the inspector and diff, and you can attribute exactly which sources each test
 * executed — finer than the per-file process observer, in a single process. This
 * guards the mechanism: two tests share a module, yet neither is credited with
 * the other's private source. The driver runs as a plain-node child (not through
 * Vitest) so script URLs are the real files; it imports the built core, so this
 * suite depends on `@covsel/core` being built.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const coreDist = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const driver = fileURLToPath(new URL('./fixtures/inspector-driver.mjs', import.meta.url));

beforeAll(() => {
  if (!existsSync(coreDist)) {
    execSync('pnpm --filter @covsel/core build', { cwd: repoRoot, stdio: 'ignore' });
  }
}, 120_000);

describe('per-test inspector observation', () => {
  it('attributes each test to exactly the sources it executes', () => {
    const res = spawnSync(process.execPath, [driver], {
      encoding: 'utf8',
      cwd: repoRoot,
    });
    if (res.status !== 0) {
      throw new Error(`inspector driver failed:\n${res.stdout}${res.stderr}`);
    }
    const { t1, t2 } = JSON.parse(res.stdout.trim()) as { t1: string[]; t2: string[] };

    expect(t1).toEqual(['src/a.mjs', 'src/shared.mjs']);
    expect(t2).toEqual(['src/b.mjs', 'src/shared.mjs']);
    // The shared module is credited to both; neither test claims the other's source.
    expect(t1).not.toContain('src/b.mjs');
    expect(t2).not.toContain('src/a.mjs');
  }, 30_000);
});
