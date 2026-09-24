import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig, toMapperConfig } from '@covsel/core';

import { write } from '../../core/test/helpers/repo.js';
import type {
  CovselFixtures,
  CovselFixturesOptions,
  PageLike,
  ServerSessionHandle,
} from '../src/fixture.js';
import type { ObservedTest } from '../src/protocol.js';

/**
 * The fixture's half of the protocol, without a browser.
 *
 * Everything it decides — whether it is recording at all, whether the window it
 * produces is usable, what the test is called — is decided from `page`,
 * `testInfo`, and the environment, so a stand-in for the first two exercises all
 * of it. What is deliberately *not* faked is the mapper: it is the real one,
 * reading real files, because the fixture's job is to hand it coverage and write
 * down what comes back.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A stand-in `page`, with whatever coverage the case needs. */
function fakePage(init: {
  coverage?: PageLike['coverage'];
  onPage?: (fire: (page: never) => void) => void;
}): PageLike {
  return {
    ...(init.coverage !== undefined ? { coverage: init.coverage } : {}),
    context: () => ({
      on: (_event: 'page', listener: (page: never) => void) => {
        init.onPage?.(listener);
        return undefined;
      },
    }),
  };
}

/** Coverage the browser would have reported for one executed script. */
const coverageOf = (entries: { url: string; source?: string }[]) => ({
  startJSCoverage: async (): Promise<void> => undefined,
  stopJSCoverage: async () =>
    entries.map((e) => ({
      ...e,
      functions: [
        { functionName: '', ranges: [{ startOffset: 0, endOffset: 40, count: 1 }] },
      ],
    })),
});

/**
 * Load a fresh copy of the fixture module under an environment.
 *
 * Fresh because the module keeps one mapper per worker, deliberately — a
 * Playwright worker's tests share a source-map cache — and a suite reusing that
 * across cases would map the second one against the first one's repository.
 */
async function load(env: Record<string, string | undefined>): Promise<{
  covselFixtures: (options?: CovselFixturesOptions) => CovselFixtures;
}> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import('../src/fixture.js')) as {
    covselFixtures: (options?: CovselFixturesOptions) => CovselFixtures;
  };
}

/** Run one test through the fixture and return what it wrote for it. */
async function runFixture(init: {
  cwd: string;
  outDir: string;
  page: PageLike;
  titlePath?: string[];
  specFile?: string;
  body?: () => Promise<void>;
  options?: CovselFixturesOptions;
  parallelIndex?: number;
}): Promise<ObservedTest | undefined> {
  const { covselFixtures } = await load({
    COVSEL_OUT: init.outDir,
    COVSEL_CWD: init.cwd,
    COVSEL_BLOCKS: '1',
    COVSEL_CONFIG: JSON.stringify(toMapperConfig(resolveConfig({}))),
  });
  const entry = covselFixtures(init.options).covselCoverage;
  if (entry === undefined) return undefined;
  const [fn] = entry;
  await fn(
    { page: init.page },
    async () => {
      await init.body?.();
    },
    {
      file: join(init.cwd, init.specFile ?? 'e2e/cart.spec.ts'),
      titlePath: init.titlePath ?? ['cart.spec.ts', 'the cart', 'adds an item'],
      ...(init.parallelIndex !== undefined ? { parallelIndex: init.parallelIndex } : {}),
    },
  );
  return written(init.outDir)[0];
}

function written(outDir: string): ObservedTest[] {
  const [name] = readdirSync(outDir);
  if (name === undefined) return [];
  return readFileSync(join(outDir, name), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ObservedTest);
}

describe('the covsel fixture outside a recording', () => {
  it('adds no fixture at all', async () => {
    // The selected runs are almost every invocation, and their whole point is to
    // be fast. An auto-fixture depending on `page` would open one for tests that
    // never asked for it, on every run, to observe nothing.
    const { covselFixtures } = await load({ COVSEL_OUT: undefined });
    expect(covselFixtures()).toEqual({});
  });

  it('treats an empty output directory as no recording', async () => {
    const { covselFixtures } = await load({ COVSEL_OUT: '' });
    expect(covselFixtures()).toEqual({});
  });
});

describe('the covsel fixture during a recording', () => {
  it('installs itself automatically, so no spec has to name it', async () => {
    const { covselFixtures } = await load({ COVSEL_OUT: temp('covsel-pw-fx-') });
    expect(covselFixtures().covselCoverage?.[1]).toEqual({ auto: true });
  });

  it('names the test by the title path Playwright greps against', async () => {
    const cwd = temp('covsel-pw-cwd-');
    write(cwd, 'src/cart.ts', 'export const total = () => 1;\n');

    const record = await runFixture({
      cwd,
      outDir: temp('covsel-pw-out-'),
      page: fakePage({ coverage: coverageOf([{ url: `file://${cwd}/src/cart.ts` }]) }),
      titlePath: ['cart.spec.ts', 'the cart', 'adds an item'],
    });

    // Not the test's own title: `--grep` is applied to the whole path, so this
    // is what a selection has to name to reach exactly this test.
    expect(record?.name).toBe('cart.spec.ts the cart adds an item');
    expect(record?.file).toBe('e2e/cart.spec.ts');
  });

  it('records the sources the browser executed', async () => {
    const cwd = temp('covsel-pw-cwd-');
    write(cwd, 'src/cart.ts', 'export function total() {\n  return 1;\n}\n');

    const record = await runFixture({
      cwd,
      outDir: temp('covsel-pw-out-'),
      page: fakePage({ coverage: coverageOf([{ url: `file://${cwd}/src/cart.ts` }]) }),
    });

    const [window] = record?.windows ?? [];
    expect(window && 'files' in window ? window.files.map((f) => f.file) : []).toEqual([
      'src/cart.ts',
    ]);
    expect(window && 'blocks' in window ? window.blocks.length : 0).toBeGreaterThan(0);
  });

  it('writes the record even when the test failed', async () => {
    // Playwright tears fixtures down either way, and a recording that lost the
    // failing test's coverage would report it as a test the run never mentioned
    // — a confusing failure for a plain one.
    const cwd = temp('covsel-pw-cwd-');
    write(cwd, 'src/cart.ts', 'export const total = () => 1;\n');
    const outDir = temp('covsel-pw-out-');

    await expect(
      runFixture({
        cwd,
        outDir,
        page: fakePage({ coverage: coverageOf([{ url: `file://${cwd}/src/cart.ts` }]) }),
        body: () => Promise.reject(new Error('assertion failed')),
      }),
    ).rejects.toThrow('assertion failed');

    expect(written(outDir).map((r) => r.name)).toEqual([
      'cart.spec.ts the cart adds an item',
    ]);
  });
});

describe('what the fixture refuses to record as a measurement', () => {
  it('fails the window when the browser has no coverage API', async () => {
    // Firefox and WebKit. Keeping the Node-side observation and calling it a
    // recording is the failure this exists to prevent: it would record that no
    // test covers the application.
    const record = await runFixture({
      cwd: temp('covsel-pw-cwd-'),
      outDir: temp('covsel-pw-out-'),
      page: fakePage({}),
    });

    const [window] = record?.windows ?? [];
    expect(window && 'failed' in window ? window.failed : '').toMatch(/Chromium/);
  });

  it('fails the window when the coverage could not be collected', async () => {
    const record = await runFixture({
      cwd: temp('covsel-pw-cwd-'),
      outDir: temp('covsel-pw-out-'),
      page: fakePage({
        coverage: {
          startJSCoverage: async (): Promise<void> => undefined,
          stopJSCoverage: () => Promise.reject(new Error('Target page has been closed')),
        },
      }),
    });

    const [window] = record?.windows ?? [];
    expect(window && 'failed' in window ? window.failed : '').toMatch(
      /Target page has been closed/,
    );
  });

  it('fails the window when the test opened a page covsel could not watch', async () => {
    // A popup's first scripts have run by the time the event announcing it
    // arrives, so what executed there is unknown rather than partly known.
    // Recorded as the primary page alone, the test would be credited with less
    // than it covers and stop being selected for the code the popup ran.
    const cwd = temp('covsel-pw-cwd-');
    write(cwd, 'src/cart.ts', 'export const total = () => 1;\n');
    let fire: ((page: never) => void) | undefined;

    const record = await runFixture({
      cwd,
      outDir: temp('covsel-pw-out-'),
      page: fakePage({
        coverage: coverageOf([{ url: `file://${cwd}/src/cart.ts` }]),
        onPage: (listener) => {
          fire = listener;
        },
      }),
      body: async () => {
        fire?.(undefined as never);
      },
    });

    const [window] = record?.windows ?? [];
    expect(window && 'failed' in window ? window.failed : '').toMatch(/further page/);
    // Not merely "there is a failure": a window carrying files as well would be
    // read as a measurement by everything downstream.
    expect(window && 'files' in window).toBe(false);
  });

  it('fails the window when a script could not be mapped back to a source', async () => {
    // A served bundle with no source map is not a test that covered nothing —
    // it is a recording that cannot say what the test covered.
    const cwd = temp('covsel-pw-cwd-');
    mkdirSync(join(cwd, 'src'), { recursive: true });

    const record = await runFixture({
      cwd,
      outDir: temp('covsel-pw-out-'),
      page: fakePage({
        coverage: coverageOf([
          { url: 'http://localhost:5173/assets/app.js', source: 'const a=1;\n' },
        ]),
      }),
    });

    const [window] = record?.windows ?? [];
    expect(window && 'failed' in window ? window.failed : '').toMatch(
      /could not be mapped/,
    );
  });

  it('reports a script the project accepted as unmappable', async () => {
    const cwd = temp('covsel-pw-cwd-');
    const outDir = temp('covsel-pw-out-');
    const { covselFixtures } = await load({
      COVSEL_OUT: outDir,
      COVSEL_CWD: cwd,
      COVSEL_BLOCKS: '1',
      COVSEL_CONFIG: JSON.stringify(
        toMapperConfig(
          resolveConfig({
            sourceMaps: { allowUnmappable: ['https://cdn.example.com/widget.js'] },
          }),
        ),
      ),
    });
    const [fn] = covselFixtures().covselCoverage ?? [];

    await fn?.(
      {
        page: fakePage({
          coverage: coverageOf([{ url: 'https://cdn.example.com/widget.js' }]),
        }),
      },
      async () => undefined,
      { file: join(cwd, 'e2e/a.spec.ts'), titlePath: ['a.spec.ts', 'runs'] },
    );

    const [record] = written(outDir);
    // The gap the project agreed to travels back with the unit, so recording can
    // name it every time it lets one through.
    expect(record?.allowedUnmappable).toEqual(['https://cdn.example.com/widget.js']);
    expect(record?.windows[0] && 'files' in record.windows[0]).toBe(true);
  });
});

describe('where the fixture writes', () => {
  it('appends to one file per worker process, a line per test', async () => {
    const cwd = temp('covsel-pw-cwd-');
    write(cwd, 'src/cart.ts', 'export const total = () => 1;\n');
    const outDir = temp('covsel-pw-out-');
    const { covselFixtures } = await load({
      COVSEL_OUT: outDir,
      COVSEL_CWD: cwd,
      COVSEL_BLOCKS: '1',
      COVSEL_CONFIG: JSON.stringify(toMapperConfig(resolveConfig({}))),
    });
    const [fn] = covselFixtures().covselCoverage ?? [];
    const page = fakePage({
      coverage: coverageOf([{ url: `file://${cwd}/src/cart.ts` }]),
    });

    for (const title of ['first', 'second']) {
      await fn?.({ page }, async () => undefined, {
        file: join(cwd, 'e2e/a.spec.ts'),
        titlePath: ['a.spec.ts', title],
      });
    }

    // Appended rather than written at exit: a worker that dies takes whatever it
    // was still holding with it, and the tests before it are worth keeping.
    expect(existsSync(join(outDir, `${process.pid}.jsonl`))).toBe(true);
    expect(written(outDir).map((r) => r.name)).toEqual([
      'a.spec.ts first',
      'a.spec.ts second',
    ]);
  });
});

/**
 * The window that watches the application server, and everything it must refuse
 * rather than record.
 *
 * These are the decisions that say what a recording may claim, and every one of
 * them fails in the same direction when it goes wrong: a test credited with less
 * than it ran, or a scope claiming ground nothing watched. Both are read later as
 * "no test covers this", which is the one answer covsel may never give quietly.
 * None of them needs a browser or a server to check.
 */
describe('the server window', () => {
  /** An inspector nothing is listening on, so `start()` fails the way it does. */
  const DEAD = 'http://127.0.0.1:1';
  const serverOptions = (over: Partial<CovselFixturesOptions['server']> = {}) => ({
    browser: { observes: ['src/**'] },
    server: { observes: ['server/**'], inspectUrl: DEAD, ...over },
  });

  it('refuses to be configured without the browser window naming its own scope', async () => {
    // With two windows the recorder's single declaration cannot stand for
    // either. Attached to the browser window it would have a browser recording
    // vouch for `server/**` — and then a change to a path *neither* window
    // watches reads as observed and covered by nothing, so no test runs.
    const { covselFixtures } = await load({ COVSEL_OUT: temp('covsel-pw-out-') });
    expect(() =>
      covselFixtures({ server: { observes: ['server/**'] } } as CovselFixturesOptions),
    ).toThrow(/browser/);
  });

  it('refuses before it opens anything, so a misconfigured project hears at load', async () => {
    // Thrown from `covselFixtures()` itself rather than from a test, so the
    // spec file fails to load instead of the suite recording a whole run under
    // a scope nobody could satisfy.
    const { covselFixtures } = await load({ COVSEL_OUT: undefined });
    expect(() =>
      covselFixtures({ server: { observes: ['server/**'] } } as CovselFixturesOptions),
    ).toThrow(/browser/);
  });

  it('gives each window its own scope, and neither the other one', async () => {
    const cwd = temp('covsel-pw-cwd-');
    write(cwd, 'src/cart.ts', 'export const total = () => 1;\n');

    const record = await runFixture({
      cwd,
      outDir: temp('covsel-pw-out-'),
      page: fakePage({ coverage: coverageOf([{ url: `file://${cwd}/src/cart.ts` }]) }),
      options: serverOptions(),
    });

    const [browser] = record?.windows ?? [];
    expect(browser && 'observes' in browser ? browser.observes : undefined).toEqual([
      'src/**',
    ]);
  });

  it('fails the window when the test ran in a second Playwright worker', async () => {
    // Both workers drive the one server process: this test would be credited
    // with the other's server execution, or its own collection stopped
    // mid-test. The second is the dangerous one — it records the test as
    // covering less of the server than it does, so a change there skips it.
    const cwd = temp('covsel-pw-cwd-');
    write(cwd, 'src/cart.ts', 'export const total = () => 1;\n');

    const record = await runFixture({
      cwd,
      outDir: temp('covsel-pw-out-'),
      page: fakePage({ coverage: coverageOf([{ url: `file://${cwd}/src/cart.ts` }]) }),
      options: serverOptions(),
      parallelIndex: 1,
    });

    const server = record?.windows[1];
    expect(server && 'failed' in server ? server.failed : '').toMatch(/--workers=1/);
    // Not merely "there is a failure": a window carrying files as well would be
    // read as a measurement by everything downstream.
    expect(server && 'files' in server).toBe(false);
  });

  it('fails the window when the server could not be reached, rather than recording nothing', async () => {
    // An unreachable inspector is not a test that ran no server code. Recorded
    // as an empty measurement it would say exactly that, and every later change
    // to the server would select this test out.
    const cwd = temp('covsel-pw-cwd-');
    write(cwd, 'src/cart.ts', 'export const total = () => 1;\n');

    const record = await runFixture({
      cwd,
      outDir: temp('covsel-pw-out-'),
      page: fakePage({ coverage: coverageOf([{ url: `file://${cwd}/src/cart.ts` }]) }),
      options: serverOptions(),
      parallelIndex: 0,
    });

    const server = record?.windows[1];
    expect(server && 'failed' in server ? server.failed : '').toMatch(/--inspect/);
    expect(server && 'files' in server).toBe(false);
  });

  it('still records the browser window when the server window failed', async () => {
    // The two failures are separate: recording fails on the combined unit, and
    // the browser's half is what makes the message about the server rather than
    // about a test that observed nothing at all.
    const cwd = temp('covsel-pw-cwd-');
    write(cwd, 'src/cart.ts', 'export const total = () => 1;\n');

    const record = await runFixture({
      cwd,
      outDir: temp('covsel-pw-out-'),
      page: fakePage({ coverage: coverageOf([{ url: `file://${cwd}/src/cart.ts` }]) }),
      options: serverOptions(),
    });

    expect(record?.windows).toHaveLength(2);
    const [browser] = record?.windows ?? [];
    expect(browser && 'files' in browser ? browser.files.map((f) => f.file) : []).toEqual(
      ['src/cart.ts'],
    );
  });
});

/**
 * A route module a server imports at boot: some top-level work, two handlers a
 * request can reach, and one nobody ever calls. Written into the temp project's
 * own tree, not run from the test's own file, so the mapper resolves its `file://`
 * URL back to a repo-relative source the way it would for a real server.
 */
const BOOT_DELTA_SERVER = `import { createServer } from 'node:http';

function bootWork() {
  return 'ran at boot';
}
bootWork();

function neverCalled() {
  return 'dead code';
}

function handleA() {
  return 'a';
}

function handleB() {
  return 'b';
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/a') handleA();
  else if (url.pathname === '/b') handleB();
  res.end('ok');
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(\`LISTENING \${server.address().port}\\n\`);
});
`;

/**
 * The boot-delta server window, against a real Node process: everything the
 * legacy per-test session cannot see, because it never observes anything before
 * its first test starts.
 *
 * This drives `covselServerSession` and `covselCoverage` directly, the way
 * Playwright's own fixture resolution would — the worker fixture opened once,
 * handed into two per-test fixture runs — because that dependency is exactly
 * what makes boot-delta mode different from the legacy session opened fresh
 * inside `openServer` above.
 */
describe('the server window in boot-delta mode', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
  });

  /** Wait for a value a background handler will eventually set. */
  async function waitFor<T>(get: () => T | undefined, label: string): Promise<T> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const value = get();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  /** A real Node process, its own route module, `--inspect` and `NODE_V8_COVERAGE` both open. */
  async function bootDeltaServer(
    cwd: string,
  ): Promise<{ inspectUrl: string; httpUrl: string; coverageDir: string }> {
    write(cwd, 'server/routes.mjs', BOOT_DELTA_SERVER);
    const coverageDir = temp('covsel-pw-bootdelta-cov-');
    const child = spawn(process.execPath, ['--inspect=0', 'server/routes.mjs'], {
      cwd,
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let inspectPort: string | undefined;
    let httpPort: string | undefined;
    child.stderr.on('data', (chunk: Buffer) => {
      const found = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(chunk.toString());
      if (found?.[1] !== undefined) inspectPort = found[1];
    });
    child.stdout.on('data', (chunk: Buffer) => {
      const found = /LISTENING (\d+)/.exec(chunk.toString());
      if (found?.[1] !== undefined) httpPort = found[1];
    });
    const [port, httpP] = await Promise.all([
      waitFor(() => inspectPort, 'the inspector port'),
      waitFor(() => httpPort, 'the http port'),
    ]);
    return {
      inspectUrl: `http://127.0.0.1:${port}`,
      httpUrl: `http://127.0.0.1:${httpP}`,
      coverageDir,
    };
  }

  it('credits boot to both tests and keeps block granularity for the rest', async () => {
    const cwd = temp('covsel-pw-cwd-');
    const { inspectUrl, httpUrl, coverageDir } = await bootDeltaServer(cwd);
    const outDir = temp('covsel-pw-out-');

    const { covselFixtures } = await load({
      COVSEL_OUT: outDir,
      COVSEL_CWD: cwd,
      COVSEL_BLOCKS: '1',
      COVSEL_CONFIG: JSON.stringify(toMapperConfig(resolveConfig({}))),
    });
    const options: CovselFixturesOptions = {
      browser: { observes: ['src/**'] },
      server: { observes: ['server/**'], inspectUrl, coverageDir },
    };
    const fixtures = covselFixtures(options);
    const serverEntry = fixtures.covselServerSession;
    const coverageEntry = fixtures.covselCoverage;
    if (serverEntry === undefined || coverageEntry === undefined) {
      throw new Error('expected both fixtures during a recording');
    }
    const [serverFn] = serverEntry;
    const [coverageFn] = coverageEntry;
    const page = fakePage({ coverage: coverageOf([]) });

    async function runOne(
      name: string,
      path: string,
      handle: ServerSessionHandle | undefined,
    ): Promise<void> {
      await coverageFn(
        { page, ...(handle !== undefined ? { covselServerSession: handle } : {}) },
        async () => {
          await fetch(`${httpUrl}${path}`);
        },
        { file: join(cwd, 'e2e/server.spec.ts'), titlePath: [name] },
      );
    }

    await serverFn(
      {},
      async (handle) => {
        await runOne('test-a', '/a', handle);
        await runOne('test-b', '/b', handle);
      },
      { parallelIndex: 0 },
    );

    const [recordA, recordB] = written(outDir);
    const serverWindowOf = (r: ObservedTest | undefined) => {
      const w = r?.windows[1];
      return w && 'blocks' in w ? w : undefined;
    };
    const a = serverWindowOf(recordA);
    const b = serverWindowOf(recordB);
    if (a === undefined || b === undefined) {
      throw new Error(
        `expected both server windows to succeed: ${JSON.stringify([recordA, recordB])}`,
      );
    }

    expect(a.files.map((f) => f.file)).toEqual(['server/routes.mjs']);
    expect(b.files.map((f) => f.file)).toEqual(['server/routes.mjs']);

    // Boot ran before either test and is credited to both; each test's own
    // handler is a block the other test does not have; the handler nobody
    // calls contributes nothing to either -- which is what tells this apart
    // from a file-granular fallback.
    const aHashes = a.blocks.map((blk) => blk.blockHash);
    const bHashes = b.blocks.map((blk) => blk.blockHash);
    const common = aHashes.filter((h) => bHashes.includes(h));
    expect(common.length).toBeGreaterThan(0);
    expect(aHashes.filter((h) => !bHashes.includes(h))).toHaveLength(1);
    expect(bHashes.filter((h) => !aHashes.includes(h))).toHaveLength(1);
    expect(aHashes).toHaveLength(common.length + 1);
    expect(bHashes).toHaveLength(common.length + 1);
  }, 30_000);

  it('fails the window when a second worker reuses the same boot-delta session', async () => {
    const cwd = temp('covsel-pw-cwd-');
    const { covselFixtures } = await load({
      COVSEL_OUT: temp('covsel-pw-out-'),
      COVSEL_CWD: cwd,
      COVSEL_BLOCKS: '1',
      COVSEL_CONFIG: JSON.stringify(toMapperConfig(resolveConfig({}))),
    });
    const options: CovselFixturesOptions = {
      browser: { observes: ['src/**'] },
      server: {
        observes: ['server/**'],
        inspectUrl: 'http://127.0.0.1:1',
        coverageDir: '/tmp',
      },
    };
    const [serverFn] = covselFixtures(options).covselServerSession ?? [];
    if (serverFn === undefined) throw new Error('expected the worker fixture');

    let handle: ServerSessionHandle | undefined;
    await serverFn(
      {},
      async (h) => {
        handle = h;
      },
      { parallelIndex: 1 },
    );

    expect(handle && 'failed' in handle ? handle.failed : '').toMatch(/--workers=1/);
  });

  it('fails the window when the boot-delta server could not be reached', async () => {
    const cwd = temp('covsel-pw-cwd-');
    const { covselFixtures } = await load({
      COVSEL_OUT: temp('covsel-pw-out-'),
      COVSEL_CWD: cwd,
      COVSEL_BLOCKS: '1',
      COVSEL_CONFIG: JSON.stringify(toMapperConfig(resolveConfig({}))),
    });
    const options: CovselFixturesOptions = {
      browser: { observes: ['src/**'] },
      server: {
        observes: ['server/**'],
        inspectUrl: 'http://127.0.0.1:1',
        coverageDir: '/tmp',
      },
    };
    const [serverFn] = covselFixtures(options).covselServerSession ?? [];
    if (serverFn === undefined) throw new Error('expected the worker fixture');

    let handle: ServerSessionHandle | undefined;
    await serverFn(
      {},
      async (h) => {
        handle = h;
      },
      { parallelIndex: 0 },
    );

    expect(handle && 'failed' in handle ? handle.failed : '').toMatch(/--inspect/);
  });
});
