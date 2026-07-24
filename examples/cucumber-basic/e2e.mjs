// End-to-end proof of scenario-level selection for cucumber-js — the runner with
// no built-in selection at all. Copies this example into a throwaway git repo,
// records one map entry per scenario, then asserts that editing one source
// selects and runs only the scenario that executed it. Run with
// `pnpm --filter @covsel/example-cucumber-basic e2e` after a build.
import { spawnSync } from 'node:child_process';
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
const cucumberBin = join(exampleDir, 'node_modules', '.bin', 'cucumber-js');

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

const tmp = mkdtempSync(join(tmpdir(), 'covsel-e2e-cucumber-'));
try {
  for (const entry of ['features', 'src']) {
    cpSync(join(exampleDir, entry), join(tmp, entry), { recursive: true });
  }
  writeFileSync(
    join(tmp, 'package.json'),
    '{\n  "name": "e2e",\n  "private": true,\n  "type": "module"\n}\n',
  );
  writeFileSync(join(tmp, '.gitignore'), '.covsel/\nnode_modules/\nmarkers.txt\n');
  // Reuse the example's installed cucumber-js.
  symlinkSync(join(exampleDir, 'node_modules'), join(tmp, 'node_modules'), 'dir');

  git(tmp, ['init', '-q', '-b', 'main']);
  git(tmp, ['config', 'user.email', 'e2e@example.com']);
  git(tmp, ['config', 'user.name', 'covsel e2e']);
  git(tmp, ['add', '.']);
  git(tmp, ['commit', '-q', '-m', 'fixture']);

  console.log('recording one map entry per scenario...');
  const rec = run(
    'node',
    [covselBin, 'record', '--adapter', 'cucumber', '--', cucumberBin],
    tmp,
  );
  process.stderr.write(rec.stderr);
  assert(rec.status === 0, 'record exits 0');

  const map = JSON.parse(readFileSync(join(tmp, '.covsel', 'map.json'), 'utf8'));
  const scenario = (name) =>
    map.entries.find((e) => e.test.name === name)?.files.map((f) => f.file) ?? [];
  assert(map.entries.length === 2, 'records one entry per scenario (2)');

  const cart = scenario('totalling a cart');
  const greeting = scenario('greeting a customer');
  assert(
    cart.includes('src/cart.mjs') && !cart.includes('src/greeting.mjs'),
    'the cart scenario covers src/cart.mjs and not the greeting source',
  );
  assert(
    greeting.includes('src/greeting.mjs') && !greeting.includes('src/cart.mjs'),
    'the greeting scenario covers src/greeting.mjs and not the cart source',
  );
  // Step definitions are executed by both scenarios, so editing them re-runs both.
  const steps = 'features/step_definitions/steps.mjs';
  assert(
    cart.includes(steps) && greeting.includes(steps),
    'both scenarios record the step definitions they share',
  );

  console.log('scenario: edit src/cart.mjs (scenario-level precision)');
  writeFileSync(
    join(tmp, 'src', 'cart.mjs'),
    `${readFileSync(join(tmp, 'src', 'cart.mjs'), 'utf8')}// edit\n`,
  );
  const affected = run('node', [covselBin, 'affected', '--adapter', 'cucumber'], tmp);
  assert(
    affected.stdout.trim() === 'features/shop.feature',
    'affected prints the feature file containing the affected scenario',
  );

  // Running the selection must execute only the affected scenario.
  const ran = run(
    'node',
    [covselBin, 'run', '--adapter', 'cucumber', '--', cucumberBin],
    tmp,
  );
  assert(ran.status === 0, 'run exits 0');
  const summary = `${ran.stdout}${ran.stderr}`;
  assert(
    /1 scenario \(1 passed\)/.test(summary),
    'run executes exactly one scenario, not the whole feature',
  );
  git(tmp, ['checkout', '--', 'src/cart.mjs']);

  console.log('scenario: edit the feature file (new/changed tests always run)');
  writeFileSync(
    join(tmp, 'features', 'shop.feature'),
    `${readFileSync(join(tmp, 'features', 'shop.feature'), 'utf8')}\n  # touched\n`,
  );
  const afterFeatureEdit = run(
    'node',
    [covselBin, 'affected', '--adapter', 'cucumber'],
    tmp,
  );
  assert(
    afterFeatureEdit.stdout.trim() === 'features/shop.feature',
    'a changed feature file is selected',
  );
  git(tmp, ['checkout', '--', 'features/shop.feature']);

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall scenarios passed');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
