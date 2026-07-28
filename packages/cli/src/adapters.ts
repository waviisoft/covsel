/**
 * How a `--adapter` name becomes an adapter. covsel ships none of them: an
 * adapter is a package the project installs, and this file finds it. Every
 * runner covsel supports is therefore surface area a project opts into rather
 * than weight in every install, and a runner nobody has written an adapter for
 * yet needs no change here to become selectable.
 *
 * This file knows how to find and load an adapter. It knows nothing about what
 * one is -- core owns that, including the runtime check.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type Adapter, assertAdapter } from '@covsel/core';

/**
 * The adapter assumed when `--adapter` is not given. A name, not an
 * implementation: it still has to be installed like any other.
 */
export const DEFAULT_ADAPTER = 'generic';

/**
 * The package specifiers a name implies. A name that is already a specifier --
 * scoped, or containing a path -- is honoured as written, so an adapter whose
 * package is named something else is still selectable. Anything else is a short
 * name, and expands to the official scope first, then the community prefix.
 */
export function adapterSpecifiers(name: string): string[] {
  if (name.startsWith('@') || name.includes('/')) return [name];
  return [`@covsel/adapter-${name}`, `covsel-adapter-${name}`];
}

/**
 * The installed package's own directory, found by walking the project's
 * `node_modules` chain. This is only reached when the standard resolver could
 * not see the package, which happens for a package whose `exports` map declares
 * an `import` condition and no `require` one -- a perfectly ordinary ESM-only
 * package, and precisely the kind an adapter is likely to be.
 */
function packageDir(cwd: string, specifier: string): string | undefined {
  const roots = createRequire(join(cwd, 'package.json')).resolve.paths(specifier) ?? [];
  for (const root of roots) {
    const dir = join(root, ...specifier.split('/'));
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return undefined;
}

/**
 * The file a package's manifest points at for its root entry, preferring what
 * an importer would get. Deliberately narrow: it answers only for the package
 * root, which is all an adapter specifier ever names, and anything it gets wrong
 * surfaces as a load failure rather than as a wrong adapter.
 */
function entryFile(dir: string): string {
  let manifest: { exports?: unknown; module?: unknown; main?: unknown } = {};
  try {
    manifest = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    ) as typeof manifest;
  } catch {
    return 'index.js';
  }
  const pick = (target: unknown): string | undefined => {
    if (typeof target === 'string') return target;
    if (typeof target !== 'object' || target === null) return undefined;
    const conditions = target as Record<string, unknown>;
    for (const key of ['import', 'node', 'default']) {
      const found = pick(conditions[key]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const exports = manifest.exports as Record<string, unknown> | string | undefined;
  // An exports object whose keys are conditions rather than subpaths *is* the
  // root target, which is how Node reads it too.
  const root =
    typeof exports === 'object' && exports !== null && '.' in exports
      ? exports['.']
      : exports;
  return (
    pick(root) ??
    (typeof manifest.module === 'string' ? manifest.module : undefined) ??
    (typeof manifest.main === 'string' ? manifest.main : undefined) ??
    'index.js'
  );
}

/**
 * Import one specifier from the project's perspective. Resolution is anchored to
 * `cwd` rather than to covsel's own location on disk: the adapter that loads has
 * to be the one this project installed, which a bare import would not guarantee
 * for a globally installed covsel or inside a monorepo. Both routes below stay
 * anchored that way -- falling back to a bare import would quietly resolve
 * against covsel instead, and report a package the project really has installed
 * as missing.
 */
async function importFrom(
  cwd: string,
  specifier: string,
): Promise<{ module: unknown } | 'not-installed'> {
  const require = createRequire(join(cwd, 'package.json'));
  let resolved: string | undefined;
  try {
    resolved = require.resolve(specifier);
  } catch {
    const dir = packageDir(cwd, specifier);
    resolved = dir === undefined ? undefined : join(dir, entryFile(dir));
  }
  if (resolved === undefined || !existsSync(resolved)) return 'not-installed';
  // Finding the package is what decides "is it installed"; from here on, whatever
  // the module throws is the adapter's own failure and has to reach the user
  // unchanged rather than reading as absent.
  return { module: await import(pathToFileURL(resolved).href) };
}

/** Why an adapter name did not become an adapter. */
export class AdapterResolutionError extends Error {}

/** What to tell someone whose adapter is not installed. */
function notInstalled(name: string, specifiers: string[]): string {
  const tried = specifiers.map((s) => `'${s}'`).join(' and ');
  const install = `npm install --save-dev ${specifiers[0]}`;
  return name === DEFAULT_ADAPTER
    ? `no adapter installed -- covsel ships none. Install one for your runner ` +
        `(\`${install}\` wraps any command), or name another with --adapter (tried ${tried})`
    : `adapter '${name}' is not installed -- \`${install}\` (tried ${tried})`;
}

/**
 * Resolve a `--adapter` name to the adapter package the project installed.
 * Throws `AdapterResolutionError` with a reason a user can act on -- nothing
 * installed under any of the names tried, a module that is not an adapter, or a
 * module that failed to load.
 */
export async function loadAdapter(name: string, cwd: string): Promise<Adapter> {
  const specifiers = adapterSpecifiers(name);
  for (const specifier of specifiers) {
    let found: { module: unknown } | 'not-installed';
    try {
      found = await importFrom(cwd, specifier);
    } catch (err) {
      throw new AdapterResolutionError(
        `'${specifier}' failed to load: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (found === 'not-installed') continue;
    // One documented shape, so a package cannot half-satisfy the protocol: the
    // adapter is the `adapter` export, or the default export.
    const exports = found.module as { adapter?: unknown; default?: unknown };
    const candidate = exports.adapter ?? exports.default;
    if (candidate === undefined) {
      throw new AdapterResolutionError(
        `'${specifier}' exports no adapter (expected an 'adapter' or default export)`,
      );
    }
    // core's own check, so every adapter is held to the same contract, whoever
    // wrote it. Its message names the capability that failed.
    assertAdapter(candidate, `'${specifier}'`);
    return candidate;
  }

  throw new AdapterResolutionError(notInstalled(name, specifiers));
}
