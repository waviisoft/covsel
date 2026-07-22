// End-to-end proof of the covsel record -> affected loop against a real Vitest
// suite. Copies this example into a throwaway git repo, records the map with the
// vitest adapter, then asserts selection under a series of edits. Run with
// `pnpm --filter @covsel/example-vitest-basic e2e` after a build.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(exampleDir, '..', '..');
const covselBin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
const vitestBin = join(exampleDir, 'node_modules', '.bin', 'vitest');

let failures = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ok  ${message}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${message}`);
  }
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.error) throw res.error;
  return res;
}

function git(cwd, args) {
  const res = run('git', args, cwd);
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

/** Lines the CLI printed to stdout (the selected test files). */
function affected(cwd) {
  const res = run('node', [covselBin, 'affected'], cwd);
  if (res.status !== 0) throw new Error(`covsel affected failed: ${res.stderr}`);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

const tmp = mkdtempSync(join(tmpdir(), 'covsel-e2e-'));
try {
  for (const entry of ['src', 'test', 'vitest.config.ts']) {
    cpSync(join(exampleDir, entry), join(tmp, entry), { recursive: true });
  }
  writeFileSync(
    join(tmp, 'package.json'),
    '{\n  "name": "e2e",\n  "private": true,\n  "type": "module"\n}\n',
  );
  writeFileSync(join(tmp, '.gitignore'), '.covsel/\nnode_modules/\n');
  // Reuse the example's installed dependencies (vitest + coverage-v8).
  symlinkSync(join(exampleDir, 'node_modules'), join(tmp, 'node_modules'), 'dir');

  git(tmp, ['init', '-q', '-b', 'main']);
  git(tmp, ['config', 'user.email', 'e2e@example.com']);
  git(tmp, ['config', 'user.name', 'covsel e2e']);
  git(tmp, ['add', '.']);
  git(tmp, ['commit', '-q', '-m', 'fixture']);

  console.log('recording map with the vitest adapter...');
  const rec = run(
    'node',
    [covselBin, 'record', '--adapter', 'vitest', '--', vitestBin, 'run'],
    tmp,
  );
  process.stderr.write(rec.stderr);
  assert(rec.status === 0, 'record exits 0');

  const map = JSON.parse(readFileSync(join(tmp, '.covsel', 'map.json'), 'utf8'));
  const covered = (file) =>
    (map.entries.find((e) => e.test.file === file)?.files ?? [])
      .map((f) => f.file)
      .sort();
  assert(
    JSON.stringify(covered('test/a.test.ts')) ===
      JSON.stringify(['src/a.ts', 'src/shared.ts']),
    'a.test.ts covers src/a.ts + src/shared.ts',
  );
  assert(
    JSON.stringify(covered('test/b.test.ts')) ===
      JSON.stringify(['src/b.ts', 'src/shared.ts']),
    'b.test.ts covers src/b.ts + src/shared.ts',
  );

  console.log('scenario: edit src/a.ts (precision)');
  writeFileSync(
    join(tmp, 'src', 'a.ts'),
    `${readFileSync(join(tmp, 'src', 'a.ts'), 'utf8')}// edit\n`,
  );
  assert(
    JSON.stringify(affected(tmp)) === JSON.stringify(['test/a.test.ts']),
    'selects only a.test.ts',
  );
  git(tmp, ['checkout', '--', 'src/a.ts']);

  console.log('scenario: edit src/shared.ts (shared code)');
  writeFileSync(
    join(tmp, 'src', 'shared.ts'),
    `${readFileSync(join(tmp, 'src', 'shared.ts'), 'utf8')}// edit\n`,
  );
  assert(
    JSON.stringify(affected(tmp)) ===
      JSON.stringify(['test/a.test.ts', 'test/b.test.ts']),
    'selects both test files',
  );
  git(tmp, ['checkout', '--', 'src/shared.ts']);

  console.log('scenario: edit package.json (sentinel -> full run)');
  writeFileSync(
    join(tmp, 'package.json'),
    '{\n  "name": "e2e2",\n  "private": true,\n  "type": "module"\n}\n',
  );
  assert(
    JSON.stringify(affected(tmp)) ===
      JSON.stringify(['test/a.test.ts', 'test/b.test.ts']),
    'sentinel change selects every test file',
  );
  git(tmp, ['checkout', '--', 'package.json']);

  console.log('scenario: add test/c.test.ts (new test always runs)');
  writeFileSync(
    join(tmp, 'test', 'c.test.ts'),
    "import { expect, test } from 'vitest';\ntest('c', () => expect(1).toBe(1));\n",
  );
  assert(affected(tmp).includes('test/c.test.ts'), 'new test file is selected');
  rmSync(join(tmp, 'test', 'c.test.ts'));

  console.log('scenario: covsel status');
  const status = run('node', [covselBin, 'status'], tmp);
  assert(
    status.status === 0 && /entries:\s*2/.test(status.stdout),
    'status reports 2 entries',
  );

  console.log('scenario: covsel run -- vitest run (only affected)');
  writeFileSync(
    join(tmp, 'src', 'a.ts'),
    `${readFileSync(join(tmp, 'src', 'a.ts'), 'utf8')}// edit\n`,
  );
  const ran = run('node', [covselBin, 'run', '--', vitestBin, 'run'], tmp);
  assert(ran.status === 0, 'run wraps the runner and exits 0');
  git(tmp, ['checkout', '--', 'src/a.ts']);

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall scenarios passed');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
