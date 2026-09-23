/**
 * The application, and the Node-based harness double, the conformance fixture
 * drives.
 *
 * A real cross-language harness belongs in `examples/harness-basic`, not here:
 * the conformance suite exists to certify this package's own mechanics
 * (recording modes, the run template, fail-open behaviour), and a Node double
 * that speaks the same wire protocol a Python or Go harness would exercises
 * every one of those without needing a second language installed to run
 * `pnpm test`.
 *
 * The app itself is a tiny HTTP server with two endpoints, each reaching a
 * different unit's source through a module both share, plus one more hop it
 * hands off to a **child process** -- the one boundary an inspector session on
 * the server cannot see, and so the fixture's blind spot.
 */

/** Port the fixture's server listens on, read from the environment so each
 * conformance check can run its own instance without colliding. */
export const HTTP_PORT_ENV = 'FIXTURE_HTTP_PORT';
/** Base URL harness.mjs calls the server at, set by the test's own orchestration. */
export const APP_URL_ENV = 'FIXTURE_APP_URL';

// Lives under server/, not the project root, so it falls inside the same
// `observes` scope as the rest of what the server executes -- the entry
// script is code the process runs like any other, and a glob that missed it
// would make every recording refuse itself the moment it started.
export const SERVER = `import { createServer } from 'node:http';

const port = Number(process.env.${HTTP_PORT_ENV});

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (url.pathname === '/alpha') {
    const { alpha } = await import('../src/a.mjs');
    res.writeHead(200).end(String(alpha(1)));
    return;
  }
  if (url.pathname === '/beta') {
    const { beta } = await import('../src/b.mjs');
    res.writeHead(200).end(String(beta(2)));
    return;
  }
  res.writeHead(404).end('');
}).listen(port, '127.0.0.1');
`;

export const SHARED = `import { base } from '../server/pricing.mjs';

export function shared(x) {
  return base(x);
}
`;

export const A = `import { shared } from './shared.mjs';

export function alpha(x) {
  return shared(x * 2);
}
`;

export const B = `import { shared } from './shared.mjs';

export function beta(x) {
  return shared(x + 1);
}
`;

/**
 * Out of process on purpose: this is the boundary the inspector session
 * cannot cross, since it watches the server process and not the ones it
 * starts, and the fixture's blind spot needs somewhere the declared scope
 * really cannot see.
 */
export const PRICING = `import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function base(qty) {
  return Number(
    execFileSync(process.execPath, [join(process.cwd(), 'jobs/run.mjs'), String(qty)], {
      encoding: 'utf8',
    }),
  );
}
`;

export const JOB = `export function compute(qty) {
  return qty * 3 + 1;
}
`;

export const JOB_RUNNER = `import { compute } from './compute.mjs';

process.stdout.write(String(compute(Number(process.argv[2] ?? 1))));
`;

/** What the server window can see -- everything except the child job. */
export const OBSERVES = ['src/**', 'server/**'];

/**
 * The tests, as anchor files `testGlobs` discovers on disk -- the id a real
 * project's harness ids would be, pending the test inventory `@covsel/core`
 * does not implement yet (issue #123). Their content is never read; the id is
 * the path.
 */
export const TEST_FILES: Record<string, string> = {
  'tests/alpha.harness': '# covers /alpha\n',
  'tests/beta.harness': '# covers /beta\n',
};

/**
 * The harness double: a plain Node script that plays the role of an external
 * runner in any language, driving the app over HTTP and speaking the boundary
 * protocol when `COVSEL_BOUNDARY` is set.
 *
 * Invoked with one or more `--only <id>`, it runs exactly those; invoked with
 * none, it runs every test it knows about -- which is what a real full-suite
 * invocation being reused as the recording, per the boundary protocol, looks
 * like.
 */
export function harnessScript(markerFile: string): string {
  return `import { appendFileSync } from 'node:fs';

const BASE_URL = process.env.${APP_URL_ENV};
const BOUNDARY = process.env.COVSEL_BOUNDARY;

const TESTS = {
  'tests/alpha.harness': { path: '/alpha', expect: 7 },
  'tests/beta.harness': { path: '/beta', expect: 10 },
};

function parseOnly(argv) {
  const ids = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') ids.push(argv[++i]);
  }
  return ids;
}

async function post(path, body) {
  const res = await fetch(\`\${BOUNDARY}\${path}\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(\`covsel boundary refused \${path}: HTTP \${res.status}\`);
}

async function runOne(id) {
  const test = TESTS[id];
  if (test === undefined) throw new Error(\`unknown test id \${id}\`);
  const res = await fetch(\`\${BASE_URL}\${test.path}\`);
  const value = Number(await res.text());
  appendFileSync('${markerFile}', \`\${id}\\n\`);
  if (value !== test.expect) {
    throw new Error(\`\${id}: expected \${test.expect}, got \${value}\`);
  }
}

async function withBoundary(id, fn) {
  if (BOUNDARY === undefined) {
    await fn();
    return;
  }
  await post('/begin', { id });
  let outcome = 'passed';
  try {
    await fn();
  } catch (err) {
    outcome = 'failed';
    throw err;
  } finally {
    await post('/end', { id, outcome });
  }
}

const only = parseOnly(process.argv.slice(2));
const ids = only.length > 0 ? only : Object.keys(TESTS);

let failed = false;
for (const id of ids) {
  try {
    await withBoundary(id, () => runOne(id));
  } catch (err) {
    failed = true;
    console.error(String(err));
  }
}
process.exit(failed ? 1 : 0);
`;
}

/** Every file the fixture project holds, for either recording mode. */
export function files(init: { markerFile: string }): Record<string, string> {
  return {
    'server/serve.mjs': SERVER,
    'src/shared.mjs': SHARED,
    'src/a.mjs': A,
    'src/b.mjs': B,
    'server/pricing.mjs': PRICING,
    'jobs/compute.mjs': JOB,
    'jobs/run.mjs': JOB_RUNNER,
    'harness.mjs': harnessScript(init.markerFile),
    ...TEST_FILES,
  };
}
