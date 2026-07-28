import { execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Dynamic resolution is a dynamic `import()`, and the CLI ships a CommonJS build
 * as well as an ESM one. A bundler targeting an older Node would rewrite that
 * import into a `require`, which cannot load an ESM-only adapter — so this runs
 * the built CJS artifact rather than the sources, which is the only place that
 * regression would show up.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cjsBundle = fileURLToPath(new URL('../dist/index.cjs', import.meta.url));

const cliSources = fileURLToPath(new URL('../src/', import.meta.url));

/** Newest mtime among the CLI's sources, to tell a stale bundle from a fresh one. */
function newestSource(): number {
  return Math.max(
    ...readdirSync(cliSources).map((f) => statSync(join(cliSources, f)).mtimeMs),
  );
}

beforeAll(() => {
  // A stale bundle would pass this test while the shipped code had changed
  // underneath it, which is the one outcome that makes the test worthless — so
  // rebuild when it is missing or older than the sources rather than trusting
  // whatever the last build left behind.
  if (!existsSync(cjsBundle) || statSync(cjsBundle).mtimeMs < newestSource()) {
    execSync('pnpm --filter covsel... build', { cwd: repoRoot, stdio: 'ignore' });
  }
}, 300_000);

describe('the built CommonJS CLI', () => {
  it('resolves an ESM-only adapter package through a dynamic import', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-cjs-'));
    try {
      writeFileSync(
        join(cwd, 'package.json'),
        '{\n  "name": "host",\n  "private": true\n}\n',
      );
      const pkg = join(cwd, 'node_modules', '@covsel', 'adapter-probe');
      mkdirSync(pkg, { recursive: true });
      // ESM-only, exports-map-only: no `main`, no `require` condition. This is
      // the package shape a CJS `require` cannot load at all, so if the built
      // bundle downlevelled its dynamic import, this fails.
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify(
          {
            name: '@covsel/adapter-probe',
            version: '0.0.0',
            type: 'module',
            exports: { '.': { import: './index.js' } },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(pkg, 'index.js'),
        [
          'export const adapter = {',
          "  name: 'probe',",
          '  formatSelection: (tests) => [...new Set(tests.map((t) => t.file))],',
          '  createRecorder: () => ({ record: async () => [] }),',
          '};',
          '',
        ].join('\n'),
      );

      const res = spawnSync(
        process.execPath,
        [
          '-e',
          `const { main } = require(${JSON.stringify(cjsBundle)});` +
            `main(['affected', '--adapter', 'probe']).then((c) => process.exit(c));`,
        ],
        { cwd, encoding: 'utf8' },
      );

      expect(res.stderr).not.toContain('unknown adapter');
      expect(res.stderr).not.toContain('failed to load');
      expect(res.status, res.stderr).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
