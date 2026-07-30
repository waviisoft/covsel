import { execSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
 * import into a `require`, which cannot load an ESM-only adapter -- so this runs
 * the built CJS artifact rather than the sources, which is the only place that
 * regression would show up.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cjsBundle = fileURLToPath(new URL('../dist/index.cjs', import.meta.url));

/**
 * Everything the bundle's behavior comes from. The CLI leaves `@covsel/core`
 * external, so the child loads core's build too, and a bundle judged fresh on
 * the CLI's sources alone would run last week's core against this week's tests.
 */
const bundledSources = ['../src/', '../../core/src/'].map((rel) =>
  fileURLToPath(new URL(rel, import.meta.url)),
);

/** Newest mtime among those sources, to tell a stale build from a fresh one. */
function newestSource(): number {
  return Math.max(
    ...bundledSources.flatMap((dir) =>
      readdirSync(dir).map((f) => statSync(join(dir, f)).mtimeMs),
    ),
  );
}

beforeAll(() => {
  // A stale bundle would pass this test while the shipped code had changed
  // underneath it, which is the one outcome that makes the test worthless -- so
  // rebuild when it is missing or older than the sources rather than trusting
  // whatever the last build left behind.
  if (!existsSync(cjsBundle) || statSync(cjsBundle).mtimeMs < newestSource()) {
    execSync('pnpm --filter covsel... build', { cwd: repoRoot, stdio: 'ignore' });
  }
}, 300_000);

/**
 * The child's environment, minus the resolution shortcuts this repo's tooling
 * sets. Vitest's workers export `NODE_PATH` pointing at pnpm's flat store, where
 * every workspace package is visible from any directory -- a child inheriting it
 * would resolve adapters no real project has installed, and these tests would be
 * answering about this workspace instead of about a user's machine.
 */
function userEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['NODE_PATH'];
  return env;
}

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
          "  createRecorder: () => ({ observes: ['**'], record: async () => [] }),",
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
        { cwd, encoding: 'utf8', env: userEnv() },
      );

      expect(res.stderr).not.toContain('not installed');
      expect(res.stderr).not.toContain('failed to load');
      expect(res.status, res.stderr).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);

  it('ships no adapter, and says so usefully when none is installed', () => {
    // Only a real Node process can answer this: covsel bundling nothing means
    // `@covsel/adapter-generic` is not resolvable from a project that has not
    // installed it, and the vitest environment aliases workspace packages so
    // that they resolve from anywhere.
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-bare-'));
    try {
      writeFileSync(join(cwd, 'package.json'), '{\n  "name": "host"\n}\n');
      const res = spawnSync(
        process.execPath,
        [
          '-e',
          `const { main } = require(${JSON.stringify(cjsBundle)});` +
            `main(['record', '--', 'node', '--test']).then((c) => process.exit(c));`,
        ],
        { cwd, encoding: 'utf8', env: userEnv() },
      );

      expect(res.status, res.stderr).toBe(1);
      expect(res.stderr).toContain('covsel ships none');
      expect(res.stderr).toContain('npm install --save-dev @covsel/adapter-generic');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);

  it('init installs the adapter a detected runner needs but the project lacks', () => {
    // The normal adoption path, and the one a check on unresolvable names must
    // not break: covsel ships no adapters, so the adapter for a detected runner
    // is missing on every first run. Only a child process with a user's
    // environment can show it missing -- in-process, pnpm's flat store makes
    // every workspace adapter resolve from anywhere.
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-init-'));
    try {
      writeFileSync(
        join(cwd, 'package.json'),
        `${JSON.stringify({ name: 'host', private: true, devDependencies: { vitest: '^3.0.0' } })}\n`,
      );
      const bin = join(cwd, 'stub-bin');
      const log = join(cwd, 'install.log');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`);
      chmodSync(join(bin, 'npm'), 0o755);
      const env = userEnv();
      env['PATH'] = `${bin}:${env['PATH'] ?? ''}`;

      const res = spawnSync(
        process.execPath,
        [
          '-e',
          `const { main } = require(${JSON.stringify(cjsBundle)});` +
            `main(['init', '--auto-approve']).then((c) => process.exit(c));`,
        ],
        { cwd, encoding: 'utf8', env },
      );

      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(log, 'utf8')).toContain('@covsel/adapter-vitest');
      expect(existsSync(join(cwd, 'covsel.json'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);

  it('loads the copy the project installed, for a name covsel documents', () => {
    // Nothing is privileged: a name covsel's own docs use resolves through the
    // same path as one it has never heard of, so a project can pin, fork, or
    // replace any adapter without covsel's cooperation. The adapter records
    // being imported, so this cannot pass by loading some other copy.
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-pinned-'));
    try {
      writeFileSync(join(cwd, 'package.json'), '{\n  "name": "host"\n}\n');
      const pkg = join(cwd, 'node_modules', '@covsel', 'adapter-vitest');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({ name: '@covsel/adapter-vitest', type: 'module' }),
      );
      writeFileSync(
        join(pkg, 'index.js'),
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(join(cwd, 'imported'))}, 'yes');`,
          'export const adapter = {',
          "  name: 'the-project-copy',",
          '  formatSelection: () => [],',
          "  createRecorder: () => ({ observes: ['**'], record: async () => [] }),",
          '};',
          '',
        ].join('\n'),
      );

      const res = spawnSync(
        process.execPath,
        [
          '-e',
          `const { main } = require(${JSON.stringify(cjsBundle)});` +
            `main(['affected', '--adapter', 'vitest']).then((c) => process.exit(c));`,
        ],
        { cwd, encoding: 'utf8', env: userEnv() },
      );

      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(join(cwd, 'imported')), "the project's copy was imported").toBe(
        true,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
