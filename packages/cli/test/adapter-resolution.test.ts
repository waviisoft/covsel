import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { adapterSpecifiers, BUILT_IN_ADAPTERS, loadAdapter } from '../src/adapters.js';

/**
 * Resolution against real packages on disk, not a mocked module loader: the
 * thing under test is what Node does with a specifier from the project's
 * perspective, so stubbing that away would leave the interesting part untested.
 */

const projects: string[] = [];

/** A throwaway project with packages installed into its own `node_modules`. */
function project(packages: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'covsel-resolve-'));
  projects.push(cwd);
  writeFileSync(
    join(cwd, 'package.json'),
    '{\n  "name": "host",\n  "private": true,\n  "type": "module"\n}\n',
  );
  for (const [name, source] of Object.entries(packages)) {
    const dir = join(cwd, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      `{\n  "name": "${name}",\n  "version": "0.0.0",\n  "type": "module",\n  "main": "index.js"\n}\n`,
    );
    writeFileSync(join(dir, 'index.js'), source);
  }
  return cwd;
}

/** A module exporting a conforming adapter under the given export name. */
const adapterModule = (name: string, exportAs: 'adapter' | 'default'): string =>
  [
    'const built = {',
    `  name: '${name}',`,
    '  formatSelection: (tests) => [...new Set(tests.map((t) => t.file))],',
    '  createRecorder: () => ({ record: async () => [] }),',
    '};',
    exportAs === 'adapter' ? 'export const adapter = built;' : 'export default built;',
    '',
  ].join('\n');

afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('adapter resolution', () => {
  it('maps a short name to the official scope, then the community prefix', () => {
    expect(adapterSpecifiers('mocha')).toEqual([
      '@covsel/adapter-mocha',
      'covsel-adapter-mocha',
    ]);
  });

  it('honours a specifier the user typed in full', () => {
    expect(adapterSpecifiers('@acme/runner-adapter')).toEqual(['@acme/runner-adapter']);
    expect(adapterSpecifiers('./local/adapter.js')).toEqual(['./local/adapter.js']);
  });

  it('resolves a built-in without touching the filesystem', async () => {
    // A directory with no package.json and nothing installed: a built-in has to
    // work with nothing but covsel present.
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-empty-'));
    projects.push(cwd);
    for (const [name, expected] of Object.entries(BUILT_IN_ADAPTERS)) {
      await expect(loadAdapter(name, cwd)).resolves.toBe(expected);
    }
  });

  it('cannot be shadowed by a package named after a built-in', async () => {
    const cwd = project({
      '@covsel/adapter-vitest': adapterModule('impostor', 'adapter'),
    });
    const resolved = await loadAdapter('vitest', cwd);
    expect(resolved).toBe(BUILT_IN_ADAPTERS['vitest']);
    expect(resolved.name).toBe('vitest');
  });

  it('resolves an installed package from the official scope', async () => {
    const cwd = project({ '@covsel/adapter-mocha': adapterModule('mocha', 'adapter') });
    const resolved = await loadAdapter('mocha', cwd);
    expect(resolved.name).toBe('mocha');
    expect(resolved.formatSelection([{ file: 'a' }, { file: 'a', name: 'x' }])).toEqual([
      'a',
    ]);
  });

  it('falls back to the community prefix, and accepts a default export', async () => {
    const cwd = project({ 'covsel-adapter-tap': adapterModule('tap', 'default') });
    await expect(loadAdapter('tap', cwd)).resolves.toMatchObject({ name: 'tap' });
  });

  it('resolves a package the user named in full', async () => {
    const cwd = project({ '@acme/runner': adapterModule('acme', 'adapter') });
    await expect(loadAdapter('@acme/runner', cwd)).resolves.toMatchObject({
      name: 'acme',
    });
  });

  it('resolves an ESM-only package whose exports map has no require condition', async () => {
    // The standard CJS resolver cannot see this shape at all, and falling back
    // to a bare import would resolve against covsel's own location instead of
    // the project's — reporting an adapter the project has installed as missing.
    const cwd = mkdtempSync(join(tmpdir(), 'covsel-resolve-'));
    projects.push(cwd);
    writeFileSync(join(cwd, 'package.json'), '{\n  "name": "host"\n}\n');
    const dir = join(cwd, 'node_modules', '@covsel', 'adapter-esm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@covsel/adapter-esm',
        type: 'module',
        exports: { '.': { import: './entry.js' } },
      }),
    );
    writeFileSync(join(dir, 'entry.js'), adapterModule('esm-only', 'adapter'));
    await expect(loadAdapter('esm', cwd)).resolves.toMatchObject({ name: 'esm-only' });
  });

  it('resolves from the project, not from covsel', async () => {
    // The same short name installed in two projects must give each project its
    // own copy — the case a bare import, resolved against covsel's own location
    // on disk, would get wrong for a global install or inside a monorepo.
    const one = project({ '@covsel/adapter-dup': adapterModule('first', 'adapter') });
    const two = project({ '@covsel/adapter-dup': adapterModule('second', 'adapter') });
    await expect(loadAdapter('dup', one)).resolves.toMatchObject({ name: 'first' });
    await expect(loadAdapter('dup', two)).resolves.toMatchObject({ name: 'second' });
  });

  it('lists what it knows and what it tried when nothing resolves', async () => {
    const cwd = project({});
    await expect(loadAdapter('frobnicate', cwd)).rejects.toThrow(
      /unknown adapter 'frobnicate'/,
    );
    const message = await loadAdapter('frobnicate', cwd).catch((e: Error) => e.message);
    for (const name of Object.keys(BUILT_IN_ADAPTERS)) {
      expect(message).toContain(`'${name}'`);
    }
    expect(message).toContain('@covsel/adapter-frobnicate');
    expect(message).toContain('covsel-adapter-frobnicate');
  });

  it('names the capability that fails the contract', async () => {
    const cwd = project({
      '@covsel/adapter-half': [
        "export const adapter = { name: 'half', formatSelection: () => [] };",
        '',
      ].join('\n'),
    });
    await expect(loadAdapter('half', cwd)).rejects.toThrow(/no createRecorder/);
  });

  it('rejects a module that exports no adapter at all', async () => {
    const cwd = project({ '@covsel/adapter-empty': 'export const unrelated = 1;\n' });
    await expect(loadAdapter('empty', cwd)).rejects.toThrow(/exports no adapter/);
  });

  it("surfaces a package's own import failure instead of calling it missing", async () => {
    // A dependency the adapter itself cannot import must not read as "you have
    // not installed the adapter" — the fix for each is completely different.
    const cwd = project({
      '@covsel/adapter-broken': "import 'a-module-that-does-not-exist';\n",
    });
    const message = await loadAdapter('broken', cwd).catch((e: Error) => e.message);
    expect(message).toContain('failed to load');
    expect(message).not.toContain('unknown adapter');
  });

  it('rejects an adapter whose default test globs would discover nothing', async () => {
    const cwd = project({
      '@covsel/adapter-noglobs': [
        'export const adapter = {',
        "  name: 'noglobs',",
        '  formatSelection: () => [],',
        '  createRecorder: () => ({ record: async () => [] }),',
        '  defaultTestGlobs: [],',
        '};',
        '',
      ].join('\n'),
    });
    await expect(loadAdapter('noglobs', cwd)).rejects.toThrow(/no test would ever be/);
  });
});
