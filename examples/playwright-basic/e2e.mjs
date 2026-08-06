// End-to-end proof of per-test selection for Playwright — the runner whose
// minutes cost the most and whose native selection (`--only-changed`) cannot see
// past the spec files into the application. Copies this example into a throwaway
// git repo, records one map entry per test from what the *browser* executed, and
// asserts that editing one function selects and runs only the test that ran it.
// Run with `pnpm --filter @covsel/example-playwright-basic e2e` after a build.
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
// The example's own Playwright, so the runner and the `@playwright/test` the
// specs import are one installation. Two copies is a supported way to get
// "Playwright Test did not expect test.beforeEach() to be called here".
const playwrightBin = join(exampleDir, 'node_modules', '.bin', 'playwright');

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

const tmp = mkdtempSync(join(tmpdir(), 'covsel-e2e-playwright-'));
try {
  for (const entry of [
    'src',
    'tests',
    'index.html',
    'playwright.config.js',
    'covsel.json',
    'vite.config.js',
  ]) {
    cpSync(join(exampleDir, entry), join(tmp, entry), { recursive: true });
  }
  writeFileSync(
    join(tmp, 'package.json'),
    '{\n  "name": "e2e",\n  "private": true,\n  "type": "module"\n}\n',
  );
  writeFileSync(join(tmp, '.gitignore'), '.covsel/\nnode_modules/\ntest-results/\n');
  // Reuse the example's installed Playwright and Vite.
  symlinkSync(join(exampleDir, 'node_modules'), join(tmp, 'node_modules'), 'dir');

  git(tmp, ['init', '-q', '-b', 'main']);
  git(tmp, ['config', 'user.email', 'e2e@example.com']);
  git(tmp, ['config', 'user.name', 'covsel e2e']);
  git(tmp, ['add', '.']);
  git(tmp, ['commit', '-q', '-m', 'fixture']);

  console.log('recording one map entry per test, from the browser...');
  const rec = run('node', [covselBin, 'record', '--', playwrightBin, 'test'], tmp);
  process.stderr.write(rec.stderr);
  assert(rec.status === 0, 'record exits 0');
  if (rec.status !== 0) {
    // Everything below reads the map, so carrying on turns a recording failure
    // -- which just printed why -- into an ENOENT stack that buries it.
    console.error('\nrecording failed; nothing further can be checked');
    process.exitCode = 1;
    process.exit(1);
  }

  const map = JSON.parse(readFileSync(join(tmp, '.covsel', 'map.json'), 'utf8'));
  assert(map.entries.length === 2, 'records one entry per test (2)');
  assert(
    JSON.stringify(map.observed) === JSON.stringify(['src/**']),
    'the map is stamped with the scope the browser recording could see',
  );

  // Every module's top level runs on page load, so both tests cover every
  // source. Block granularity is not a nicety here -- it is the whole value.
  const covered = (name) =>
    map.entries.find((e) => e.test.name === name)?.files.map((f) => f.file) ?? [];
  assert(
    covered('shop.spec.js adds an item to the cart').includes('src/cart.ts'),
    'the cart test covers src/cart.ts',
  );
  assert(
    covered('shop.spec.js shows the profile').includes('src/cart.ts'),
    'so does the profile test — file granularity alone would select both',
  );

  console.log('scenario: edit addToCart (only the cart test ever ran it)');
  const cartSource = join(tmp, 'src', 'cart.ts');
  writeFileSync(
    cartSource,
    readFileSync(cartSource, 'utf8').replace(
      "return `${label('cart')} added`;",
      "return label('cart') + ' added';",
    ),
  );
  const affected = run('node', [covselBin, 'affected'], tmp);
  assert(
    affected.stdout.trim() === 'tests/shop.spec.js',
    'affected prints the spec file',
  );

  const ran = run('node', [covselBin, 'run', '--', playwrightBin, 'test'], tmp);
  const summary = `${ran.stdout}${ran.stderr}`;
  assert(ran.status === 0, 'run exits 0');
  assert(
    /Running 1 test/.test(summary),
    'run executes exactly one of the two tests, narrowed by --grep',
  );
  assert(
    /adds an item to the cart/.test(summary) && !/shows the profile/.test(summary),
    'and it is the test that executed the changed function',
  );
  git(tmp, ['checkout', '--', 'src/cart.ts']);

  console.log('scenario: edit a path the browser never runs (falls open)');
  writeFileSync(join(tmp, 'server.js'), 'export const port = 3000;\n');
  git(tmp, ['add', 'server.js']);
  git(tmp, ['commit', '-q', '-m', 'server']);
  writeFileSync(join(tmp, 'server.js'), 'export const port = 3001;\n');
  const outside = run('node', [covselBin, 'affected'], tmp);
  assert(
    /full run/.test(`${outside.stdout}${outside.stderr}`),
    'a change outside `observes` runs everything rather than reading as uncovered',
  );

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall scenarios passed');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
