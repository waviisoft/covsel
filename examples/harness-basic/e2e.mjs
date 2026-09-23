// End-to-end proof of the covsel record -> affected loop against an external,
// non-Node harness (a toy Python script) driving a Node server over HTTP,
// recorded from the server's own inspector -- see
// docs/guide/adapters/harness.md. Copies this example into a throwaway git
// repo, starts the server the way a real project's CI would (before covsel
// ever runs, and left running for the whole recording), then exercises both
// recording modes: one harness invocation per test, and the boundary
// protocol's single cooperating invocation. Run with
// `pnpm --filter @covsel/example-harness-basic e2e` after a build.
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(exampleDir, '..', '..');
const covselBin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');

const APP_URL = 'http://127.0.0.1:8934';
const INSPECT_URL = 'http://127.0.0.1:9339';

let failures = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ok  ${message}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${message}`);
  }
}

function run(cmd, args, cwd, env) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (res.error) throw res.error;
  return res;
}

function git(cwd, args) {
  const res = run('git', args, cwd);
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

/** Lines the CLI printed to stdout (the selected test ids). */
function affected(cwd) {
  const res = run('node', [covselBin, 'affected'], cwd);
  if (res.status !== 0) throw new Error(`covsel affected failed: ${res.stderr}`);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

async function waitUntilUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the app server never answered ${url} within ${timeoutMs}ms`);
}

const tmp = mkdtempSync(join(tmpdir(), 'covsel-e2e-harness-'));
let server;
try {
  for (const entry of ['server.mjs', 'src', 'harness', 'covsel.json', 'package.json']) {
    cpSync(join(exampleDir, entry), join(tmp, entry), { recursive: true });
  }
  writeFileSync(join(tmp, '.gitignore'), '.covsel/\nnode_modules/\n**/__pycache__/\n');
  symlinkSync(join(exampleDir, 'node_modules'), join(tmp, 'node_modules'), 'dir');

  git(tmp, ['init', '-q', '-b', 'main']);
  git(tmp, ['config', 'user.email', 'e2e@example.com']);
  git(tmp, ['config', 'user.name', 'covsel e2e']);
  git(tmp, ['add', '.']);
  git(tmp, ['commit', '-q', '-m', 'fixture']);

  console.log(
    'starting the app server (as a real project’s CI would, before recording)...',
  );
  server = spawn(process.execPath, ['--inspect=9339', 'server.mjs'], {
    cwd: tmp,
    env: { ...process.env, PORT: '8934' },
    stdio: 'ignore',
  });
  await waitUntilUp(`${APP_URL}/health`, 10_000);
  assert(true, 'app server is up, with its inspector open at ' + INSPECT_URL);

  console.log('recording map: mode (a), one harness invocation per test...');
  const rec = run('node', [covselBin, 'record', '--', 'python3', 'harness/run.py'], tmp);
  process.stderr.write(rec.stderr);
  assert(rec.status === 0, 'record exits 0');

  const map = JSON.parse(readFileSync(join(tmp, '.covsel', 'map.json'), 'utf8'));
  const covered = (file) =>
    (map.entries.find((e) => e.test.file === file)?.files ?? [])
      .map((f) => f.file)
      .sort();
  assert(
    JSON.stringify(covered('harness/tests/add.harness')) ===
      JSON.stringify(['server.mjs', 'src/add.mjs', 'src/shared.mjs']),
    'add.harness covers server.mjs + src/add.mjs + src/shared.mjs',
  );
  assert(
    JSON.stringify(covered('harness/tests/sub.harness')) ===
      JSON.stringify(['server.mjs', 'src/shared.mjs', 'src/sub.mjs']),
    'sub.harness covers server.mjs + src/sub.mjs + src/shared.mjs',
  );

  console.log('scenario: edit src/add.mjs (precision)');
  writeFileSync(
    join(tmp, 'src', 'add.mjs'),
    `${readFileSync(join(tmp, 'src', 'add.mjs'), 'utf8')}// edit\n`,
  );
  assert(
    JSON.stringify(affected(tmp)) === JSON.stringify(['harness/tests/add.harness']),
    'selects only add.harness',
  );
  git(tmp, ['checkout', '--', 'src/add.mjs']);

  console.log('scenario: edit src/shared.mjs (shared code)');
  writeFileSync(
    join(tmp, 'src', 'shared.mjs'),
    `${readFileSync(join(tmp, 'src', 'shared.mjs'), 'utf8')}// edit\n`,
  );
  assert(
    JSON.stringify(affected(tmp)) ===
      JSON.stringify(['harness/tests/add.harness', 'harness/tests/sub.harness']),
    'selects both tests',
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
      JSON.stringify(['harness/tests/add.harness', 'harness/tests/sub.harness']),
    'sentinel change selects every test',
  );
  git(tmp, ['checkout', '--', 'package.json']);

  console.log('scenario: add harness/tests/mul.harness (new test always runs)');
  writeFileSync(join(tmp, 'harness', 'tests', 'mul.harness'), '# covers /mul\n');
  assert(affected(tmp).includes('harness/tests/mul.harness'), 'new test is selected');
  rmSync(join(tmp, 'harness', 'tests', 'mul.harness'));

  console.log('scenario: covsel status');
  const status = run('node', [covselBin, 'status'], tmp);
  assert(
    status.status === 0 && /entries:\s*2/.test(status.stdout),
    'status reports 2 entries',
  );

  console.log('scenario: covsel run -- python3 harness/run.py (only affected)');
  writeFileSync(
    join(tmp, 'src', 'add.mjs'),
    `${readFileSync(join(tmp, 'src', 'add.mjs'), 'utf8')}// edit\n`,
  );
  const ran = run('node', [covselBin, 'run', '--', 'python3', 'harness/run.py'], tmp);
  assert(ran.status === 0, 'run wraps the harness and exits 0');
  git(tmp, ['checkout', '--', 'src/add.mjs']);

  console.log('scenario: an empty selection never runs the bare harness command');
  // Nothing changed since the last commit, so nothing is affected -- and the
  // one thing this must never do is run the harness with no `--only` at all,
  // which is a full run silently standing in for "nothing to do".
  const nothingSelected = run(
    'node',
    [covselBin, 'run', '--', 'python3', 'harness/run.py', '--format', 'json'],
    tmp,
  );
  assert(
    nothingSelected.status === 0,
    'an empty selection exits 0 without running anything',
  );

  console.log('recording map: mode (b), one invocation through the boundary protocol...');
  writeFileSync(
    join(tmp, 'covsel.json'),
    JSON.stringify(
      {
        adapter: 'harness',
        testGlobs: ['harness/tests/**/*.harness'],
        harness: {
          run: '--only {id}',
          server: { inspectUrl: INSPECT_URL, observes: ['src/**', 'server.mjs'] },
          boundary: {},
        },
      },
      null,
      2,
    ) + '\n',
  );
  git(tmp, ['commit', '-q', '-am', 'switch to the boundary protocol']);
  const recBoundary = run(
    'node',
    [covselBin, 'record', '--', 'python3', 'harness/run.py'],
    tmp,
  );
  process.stderr.write(recBoundary.stderr);
  assert(recBoundary.status === 0, 'record exits 0 through the boundary protocol');

  const boundaryMap = JSON.parse(readFileSync(join(tmp, '.covsel', 'map.json'), 'utf8'));
  const boundaryCovered = (file) =>
    (boundaryMap.entries.find((e) => e.test.file === file)?.files ?? [])
      .map((f) => f.file)
      .sort();
  assert(
    JSON.stringify(boundaryCovered('harness/tests/add.harness')) ===
      JSON.stringify(['server.mjs', 'src/add.mjs', 'src/shared.mjs']),
    'the boundary-protocol recording covers the same sources as one invocation per test',
  );

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall scenarios passed');
  }
} finally {
  server?.kill();
  rmSync(tmp, { recursive: true, force: true });
}
