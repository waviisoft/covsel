/**
 * The application the conformance fixture drives, as source strings.
 *
 * A conformance fixture has to give the adapter what it really meets: an
 * `http://` script that is nobody's file, resolved back to a repo source through
 * a map. A real dev server does that, and using one would also put a third
 * party's transform between the suite and the adapter — so conformance would
 * start failing for reasons that are not the adapter's. This serves the
 * fixture's own files verbatim with an identity map instead: same shape, nothing
 * between.
 */

/** Where the fixture's server listens. Fixed, because Playwright needs the URL. */
export const APP_PORT = 45817;

/**
 * The fixture's server.
 *
 * Two things beyond serving files. It answers `/api/price` from a module it
 * loads per endpoint, so both units' assertions depend on server code the
 * *browser* never executes — and on different files, so a file-granular server
 * window has something to tell them apart with. And it appends an identity
 * source map to every module it serves.
 *
 * The map is per **column**, not per line, and that is not fussiness. A
 * line-granularity map has no segment at the offset a function's coverage range
 * starts on, so the projected region begins a line late, misses that function's
 * own probe, and the block falls back to whatever wider region does contain it —
 * which is the module, which always ran. The result is a recording where every
 * test covers every function: safe, and useless as a fixture for the block-level
 * selection this suite exists to check.
 */
export const SERVER = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.cwd();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n) => {
  let bits = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = bits & 31;
    bits >>>= 5;
    if (bits > 0) digit |= 32;
    out += B64[digit];
  } while (bits > 0);
  return out;
};

/** A character-for-character map from the served text back onto its file. */
function identityMap(rel, text) {
  const lines = text.split('\\n');
  // Only the generated column resets at a ';'. The source line and column are
  // running deltas across the whole string, and treating them as per-line is how
  // a hand-written map ends up describing something else entirely.
  let prevSrcLine = 0;
  let prevSrcCol = 0;
  const mappings = lines
    .map((line, i) => {
      const segments = [];
      let prevGenCol = 0;
      for (let c = 0; c < line.length; c++) {
        segments.push(
          vlq(c - prevGenCol) + vlq(0) + vlq(i - prevSrcLine) + vlq(c - prevSrcCol),
        );
        prevGenCol = c;
        prevSrcLine = i;
        prevSrcCol = c;
      }
      return segments.join(',');
    })
    .join(';');
  return {
    version: 3,
    sources: [basename(rel)],
    sourcesContent: [text],
    names: [],
    mappings,
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/price') {
    const qty = Number(url.searchParams.get('qty') ?? 1);
    // Loaded on demand, so a test that never asks for one never executes it --
    // the server-side counterpart of the browser's dynamic import, and what lets
    // a file-granular server window tell the two units apart.
    const price =
      url.searchParams.get('kind') === 'beta'
        ? (await import('./beta.mjs')).betaPrice(qty)
        : (await import('./alpha.mjs')).alphaPrice(qty);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ price }));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(readFileSync(join(root, 'index.html'), 'utf8'));
    return;
  }
  const rel = url.pathname.replace(/^\\/+/, '');
  let text;
  try {
    text = readFileSync(join(root, rel), 'utf8');
  } catch {
    res.writeHead(404).end('');
    return;
  }
  const inline = Buffer.from(JSON.stringify(identityMap(rel, text))).toString('base64');
  res.writeHead(200, { 'content-type': 'text/javascript' });
  res.end(\`\${text}
//# sourceMappingURL=data:application/json;base64,\${inline}
\`);
}).listen(${APP_PORT}, '127.0.0.1');
`;

export const INDEX_HTML = `<!doctype html>
<html>
  <body>
    <button id="alpha">alpha</button>
    <button id="beta">beta</button>
    <div id="out"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;

/** Reached only through `a.js` and `b.js`, which is what makes it shared. */
export const SHARED = `export function shared(x) {
  return x + 100;
}
`;

const unit = (name: string, expr: string) =>
  `import { shared } from './shared.js';

export function ${name}(x) {
  return shared(${expr});
}
`;

export const A = unit('alpha', 'x * 2');
export const B = unit('beta', 'x + 1');

/**
 * Both handlers ask the server for a number and feed it through their own unit's
 * source, so every assertion depends on `server/logic.mjs` as well.
 *
 * The units are reached by *dynamic* import, and that is the point rather than a
 * detail. A statically imported module's top level runs the moment the page
 * loads, so every test would record every module and file-level attribution
 * would say nothing — which is true of a real bundled application too, and is
 * why block granularity carries this adapter. Loading each unit only when its
 * button is clicked gives the suite a file-level difference to check as well,
 * and it is the shape a static import graph gets wrong: nothing in the module
 * graph says which of these a given test reaches.
 */
export const MAIN = `const out = document.querySelector('#out');
async function base(kind) {
  return (await (await fetch(\`/api/price?qty=1&kind=\${kind}\`)).json()).price;
}
document.querySelector('#alpha').addEventListener('click', async () => {
  const { alpha } = await import('./a.js');
  out.textContent = String(alpha(await base('alpha')));
});
document.querySelector('#beta').addEventListener('click', async () => {
  const { beta } = await import('./b.js');
  out.textContent = String(beta(await base('beta')));
});
`;

/**
 * The server's own sources, one per endpoint plus the one they both go through.
 *
 * Not named `shared`: the conformance suite rejects a fixture whose other files
 * mention the shared source's stem, because a test file naming it would make the
 * recall checks certify nothing.
 *
 * Split because the server window is file-granular: what it can show is that a
 * test executed *this* server file and not that one. A single module both units
 * reach would prove only that something on the server ran.
 */
export const SERVER_PRICING = `import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function base(qty) {
  // Out of process on purpose. See JOB below: this is the boundary neither
  // window can cross, and the suite needs one to hold the declaration against.
  return Number(
    execFileSync(process.execPath, [join(process.cwd(), 'jobs/run.mjs'), String(qty)], {
      encoding: 'utf8',
    }),
  );
}
`;

const endpoint = (name: string) =>
  `import { base } from './pricing.mjs';

export function ${name}(qty) {
  return base(qty);
}
`;

export const SERVER_ALPHA = endpoint('alphaPrice');
export const SERVER_BETA = endpoint('betaPrice');

/**
 * Work the server hands to a second process, and the fixture's blind spot.
 *
 * Both units reach it — every price they assert on comes through here — and
 * neither window can see it: the browser is a different isolate, and the
 * inspector session watches the server process, not the ones it starts. That is
 * the boundary a repo-path scope cannot describe, which is exactly what the
 * declaration has to be held against.
 */
export const JOB = `export function compute(qty) {
  return qty * 3 + 1;
}
`;

export const JOB_RUNNER = `import { compute } from './compute.mjs';

process.stdout.write(String(compute(Number(process.argv[2] ?? 1))));
`;

/**
 * `covselFixtures()` on the project's own `test`, exactly as the docs tell a
 * project to write it — so the suite certifies the setup users are given rather
 * than a private one.
 */
export function fixtures(server?: { observes: string[]; inspectUrl: string }): string {
  const options =
    server === undefined
      ? ''
      : `{
    browser: { observes: ${JSON.stringify(BROWSER_OBSERVES)} },
    server: ${JSON.stringify(server)},
  }`;
  return `import { test as base, expect } from '@playwright/test';
import { covselFixtures } from '@covsel/adapter-playwright/fixture';

export const test = base.extend(covselFixtures(${options}));
export { expect };
`;
}

/** A spec, with each test recording that it ran under the name covsel gives it. */
export function spec(
  markerFile: string,
  tests: { title: string; button: string; expected: string }[],
): string {
  return `import { appendFileSync } from 'node:fs';
import { expect, test } from './fixtures.js';

test.beforeEach(({}, testInfo) => {
  appendFileSync('${markerFile}', testInfo.titlePath.join(' ') + '\\n');
});

${tests
  .map(
    (t) => `test('${t.title}', async ({ page }) => {
  await page.goto('/');
  await page.click('#${t.button}');
  await expect(page.locator('#out')).toHaveText('${t.expected}');
});`,
  )
  .join('\n\n')}
`;
}

/**
 * The Playwright config, pinned to chromium because recording reads its coverage.
 *
 * `COVSEL_CHROMIUM_PATH` points Playwright at a browser already on the machine,
 * for anywhere its own download does not reach — an air-gapped runner, a
 * container that ships one. Unset, which is the normal case, Playwright resolves
 * the browser it installed.
 */
export function playwrightConfig(options: { inspectPort?: number } = {}): string {
  const command =
    options.inspectPort === undefined
      ? "'node server/serve.mjs'"
      : `'node --inspect=${options.inspectPort} server/serve.mjs'`;
  // One worker whenever the server is observed: the window is collected from the
  // one server process, and a second worker's test executing there at the same
  // time would be credited to this one.
  const workers = options.inspectPort === undefined ? '' : '\n  workers: 1,';
  return `import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executablePath = process.env.COVSEL_CHROMIUM_PATH;

export default {
  testDir: './tests',
  // Out of the project entirely. Playwright's default \`test-results/\` lands in
  // the working tree, and covsel reads an untracked directory as a change like
  // any other -- one outside the declared scope, so every selection after the
  // first run would fall open. A real project gitignores it; this fixture has no
  // .gitignore of its own, because the conformance suite owns that file.
  outputDir: mkdtempSync(join(tmpdir(), 'covsel-conformance-pw-out-')),${workers}
  projects: [{ name: 'chromium' }],
  use: {
    baseURL: 'http://127.0.0.1:${APP_PORT}',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: ${command},
    url: 'http://127.0.0.1:${APP_PORT}/api/price?qty=1',
    // Never reuse: each conformance check records a fresh temp project, and a
    // server left over from the previous one would serve the wrong files.
    reuseExistingServer: false,
  },
  reporter: 'line',
};
`;
}

/** What the browser window can see, and the only scope it may claim. */
export const BROWSER_OBSERVES = ['src/**'];
/** What the server window can see. Its own files, and nothing it shells out to. */
export const SERVER_OBSERVES = ['server/**'];
/** The port the fixture's server opens its inspector on, when it opens one. */
export const INSPECT_PORT = 45818;

/**
 * Every file the fixture project holds.
 *
 * The same application either way. What changes with `server` is only whether the
 * project is set up to observe it — the config, and the one line the fixture
 * extends `test` with — so the two conformance runs differ in what covsel was
 * told to watch and in nothing else.
 */
export function files(init: {
  markerFile: string;
  server?: boolean;
}): Record<string, string> {
  return {
    'index.html': INDEX_HTML,
    'playwright.config.js': playwrightConfig(
      init.server === true ? { inspectPort: INSPECT_PORT } : {},
    ),
    'server/serve.mjs': SERVER,
    'server/pricing.mjs': SERVER_PRICING,
    'server/alpha.mjs': SERVER_ALPHA,
    'server/beta.mjs': SERVER_BETA,
    'jobs/compute.mjs': JOB,
    'jobs/run.mjs': JOB_RUNNER,
    'src/shared.js': SHARED,
    'src/a.js': A,
    'src/b.js': B,
    'src/main.js': MAIN,
    'tests/fixtures.js':
      init.server === true
        ? fixtures({
            observes: SERVER_OBSERVES,
            inspectUrl: `http://127.0.0.1:${INSPECT_PORT}`,
          })
        : fixtures(),
    'tests/demo.spec.js': spec(init.markerFile, [
      // compute(1) is 4; alpha doubles it and shared adds 100.
      { title: 'alpha test', button: 'alpha', expected: '108' },
      { title: 'beta test', button: 'beta', expected: '105' },
    ]),
  };
}
