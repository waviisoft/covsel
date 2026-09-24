/**
 * A minimal, real application for the recorder unit tests to point at --
 * something with a genuine inspector to connect to and a genuine file for
 * `V8FileMapper` to resolve, so these tests exercise the same path a real
 * recording does rather than stubbing the inspector away.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface InspectedApp {
  cwd: string;
  inspectUrl: string;
  child: ChildProcess;
}

/** `app.mjs`, doing just enough that a coverage window records something. */
const APP_SOURCE = 'setInterval(() => JSON.parse(\'{"a":1}\'), 5);\n';

/**
 * Start a real, inspected Node process for a test to point a recorder at. The
 * default source just does enough that any window records something; a
 * caller proving something more specific about *when* the server does work
 * (e.g. a `settleMs` test, which needs work that happens after a window would
 * ordinarily have already closed) supplies its own.
 */
export async function startInspectedApp(
  source: string = APP_SOURCE,
): Promise<InspectedApp> {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-adapter-harness-'));
  writeFileSync(join(cwd, 'app.mjs'), source);
  const child = spawn(process.execPath, ['--inspect=0', 'app.mjs'], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(
      () => reject(new Error(`no inspector announced itself: ${seen}`)),
      20_000,
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      const found = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(seen);
      if (found?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
  });
  return { cwd, inspectUrl: `http://127.0.0.1:${port}`, child };
}
