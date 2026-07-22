// End-to-end proof of the covsel record -> affected loop against node:test using
// the generic NODE_V8_COVERAGE path — zero runner integration, no coverage
// provider. Copies this example into a throwaway git repo, records the map, then
// asserts selection under a series of edits. Run with
// `pnpm --filter @covsel/example-node-test-basic e2e` after a build.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(exampleDir, '..', '..');
const covselBin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');

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

const tmp = mkdtempSync(join(tmpdir(), 'covsel-e2e-node-'));
try {
  for (const entry of ['src', 'test', 'package.json']) {
    cpSync(join(exampleDir, entry), join(tmp, entry), { recursive: true });
  }
  writeFileSync(join(tmp, '.gitignore'), '.covsel/\n');

  git(tmp, ['init', '-q', '-b', 'main']);
  git(tmp, ['config', 'user.email', 'e2e@example.com']);
  git(tmp, ['config', 'user.name', 'covsel e2e']);
  git(tmp, ['add', '.']);
  git(tmp, ['commit', '-q', '-m', 'fixture']);

  console.log('recording map with the generic (NODE_V8_COVERAGE) path...');
  const rec = run('node', [covselBin, 'record', '--', 'node', '--test'], tmp);
  process.stderr.write(rec.stderr);
  assert(rec.status === 0, 'record exits 0');

  const map = JSON.parse(readFileSync(join(tmp, '.covsel', 'map.json'), 'utf8'));
  const covered = (file) =>
    (map.entries.find((e) => e.test.file === file)?.files ?? [])
      .map((f) => f.file)
      .sort();
  assert(
    JSON.stringify(covered('test/a.test.mjs')) ===
      JSON.stringify(['src/a.mjs', 'src/shared.mjs']),
    'a.test.mjs covers src/a.mjs + src/shared.mjs',
  );
  assert(
    JSON.stringify(covered('test/b.test.mjs')) ===
      JSON.stringify(['src/b.mjs', 'src/shared.mjs']),
    'b.test.mjs covers src/b.mjs + src/shared.mjs',
  );

  console.log('scenario: edit src/a.mjs (precision)');
  writeFileSync(
    join(tmp, 'src', 'a.mjs'),
    `${readFileSync(join(tmp, 'src', 'a.mjs'), 'utf8')}// edit\n`,
  );
  assert(
    JSON.stringify(affected(tmp)) === JSON.stringify(['test/a.test.mjs']),
    'selects only a.test.mjs',
  );
  git(tmp, ['checkout', '--', 'src/a.mjs']);

  console.log('scenario: edit src/shared.mjs (shared code)');
  writeFileSync(
    join(tmp, 'src', 'shared.mjs'),
    `${readFileSync(join(tmp, 'src', 'shared.mjs'), 'utf8')}// edit\n`,
  );
  assert(
    JSON.stringify(affected(tmp)) ===
      JSON.stringify(['test/a.test.mjs', 'test/b.test.mjs']),
    'selects both test files',
  );
  git(tmp, ['checkout', '--', 'src/shared.mjs']);

  console.log('scenario: edit package.json (sentinel -> full run)');
  writeFileSync(
    join(tmp, 'package.json'),
    readFileSync(join(tmp, 'package.json'), 'utf8').replace(
      '"version": "0.0.0"',
      '"version": "0.0.1"',
    ),
  );
  assert(
    JSON.stringify(affected(tmp)) ===
      JSON.stringify(['test/a.test.mjs', 'test/b.test.mjs']),
    'sentinel change selects every test file',
  );
  git(tmp, ['checkout', '--', 'package.json']);

  console.log('scenario: add test/c.test.mjs (new test always runs)');
  writeFileSync(
    join(tmp, 'test', 'c.test.mjs'),
    "import { test } from 'node:test';\ntest('c', () => {});\n",
  );
  assert(affected(tmp).includes('test/c.test.mjs'), 'new test file is selected');
  rmSync(join(tmp, 'test', 'c.test.mjs'));

  console.log('scenario: covsel status');
  const status = run('node', [covselBin, 'status'], tmp);
  assert(
    status.status === 0 && /entries:\s*2/.test(status.stdout),
    'status reports 2 entries',
  );

  console.log('scenario: covsel run -- node --test (only affected)');
  writeFileSync(
    join(tmp, 'src', 'a.mjs'),
    `${readFileSync(join(tmp, 'src', 'a.mjs'), 'utf8')}// edit\n`,
  );
  const ran = run('node', [covselBin, 'run', '--', 'node', '--test'], tmp);
  assert(ran.status === 0, 'run wraps the runner and exits 0');
  git(tmp, ['checkout', '--', 'src/a.mjs']);

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall scenarios passed');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
